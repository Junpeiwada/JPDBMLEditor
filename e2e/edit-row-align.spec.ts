import { test, expect } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// 編集行(ColumnEditRow)が表示行と同じ列位置・同じ行高で出ることの確認。
// 2026-07-14 ユーザー決定: 1段目は表示行と同一グリッド(名前/型/note を表示セルに重ねる)、
// 表示行に対応する列が無い PK/NOT NULL/default は直下の補助段に出す。
const PATH = '/Users/test/mini.dbml';
const SRC = `Table T {
  "id" int [pk]
  "status_code" varchar [not null, default: '0', note: '区分']
}
`;

// 複数行 note のカラム(行が縦に伸びている)。編集行が表示行の高さを保てるかの確認用。
const MULTILINE_PATH = '/Users/test/multi.dbml';
const MULTILINE_SRC = `Table T {
  "id" int [pk]
  "status_code" varchar [note: '区分\\n0:未\\n1:済']
}
`;

test('編集行の名前/型/note が表示行と同じ列位置・行高で出る', async ({ page }) => {
  await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home'); // LOD 無効化(カラム行を必ず描かせる)
  await node.locator('.table-drag-handle').click(); // フォーカスモードへ

  // 編集前: 2行目(status_code)の各表示セルの位置と、行そのものの高さを測る。
  const nameCell = node.locator('[data-cell="name"]').nth(1);
  const typeCell = node.locator('[data-cell="type"]').nth(1);
  const noteCell = node.locator('[data-cell="note"]').nth(1);
  const before = {
    name: await nameCell.boundingBox(),
    type: await typeCell.boundingBox(),
    note: await noteCell.boundingBox(),
    row: await node.locator('[data-cell="name"]').nth(1).evaluate((el) => {
      const row = el.parentElement as HTMLElement;
      const r = row.getBoundingClientRect();
      return { x: r.x, y: r.y, height: r.height };
    }),
    // note の1行目の上端。編集を開始すると表示セルは入力行に置き換わって参照できなくなるため、
    // ここで測っておく。
    noteFirstLineY: await noteCell.evaluate(
      (el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().y,
    ),
  };
  await node.screenshot({ path: 'e2e/__screenshots__/edit-row-align-before.png' });

  // 名前セルをダブルクリックして編集開始。
  await nameCell.dblclick();
  // ノード内に絞る(検索欄の placeholder「検索: テーブル名・カラム名」に部分一致するため)。
  const nameField = node.getByPlaceholder('カラム名');
  await expect(nameField).toBeVisible();
  await expect(nameField).toHaveValue('status_code');

  const after = {
    name: await nameField.boundingBox(),
    type: await node.getByPlaceholder('型').boundingBox(),
    note: await node.getByPlaceholder('note').boundingBox(),
  };
  await node.screenshot({ path: 'e2e/__screenshots__/edit-row-align-after.png' });

  // 補助段に PK / NOT NULL / default が出ている。
  await expect(node.getByPlaceholder('default')).toBeVisible();
  await expect(node.getByPlaceholder('default')).toHaveValue('0');

  // 列位置: 各入力欄の左端が表示セルの左端と一致する。枠線は幅を消費しない inset shadow、
  // 内側パディングは 0 なので、構造上ほぼ 0px 一致するはず(丸め分だけ許容する)。
  const TOL = 1.5;
  for (const field of ['name', 'type', 'note'] as const) {
    expect(after[field], `${field} の入力欄が見えている`).not.toBeNull();
    expect(
      Math.abs(after[field]!.x - before[field]!.x),
      `${field}: 編集行の入力欄の左端が表示セルとほぼ同位置 (表示=${before[field]!.x} 編集=${after[field]!.x})`,
    ).toBeLessThanOrEqual(TOL);
  }

  // 列幅: 入力欄が表示セルと同じ幅を使える(狭いと表示では収まっている字面が編集中だけ見切れる)。
  for (const field of ['name', 'type', 'note'] as const) {
    expect(
      after[field]!.width,
      `${field}: 入力欄の幅が表示セル以上 (表示=${before[field]!.width} 編集=${after[field]!.width})`,
    ).toBeGreaterThanOrEqual(before[field]!.width - 0.5);
  }

  // 字面: 表示で収まっている値が編集中に見切れない(datalist のピッカー矢印など、
  // 入力欄の内部余白で字が押し出されていないこと)。
  for (const [label, locator] of [
    ['名前', nameField],
    ['型', node.getByPlaceholder('型')],
  ] as const) {
    const overflow = await locator.evaluate((el: HTMLInputElement) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `${label}: 表示で収まる値が入力欄でも収まる (内容=${overflow.scrollWidth} 枠=${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(overflow.clientWidth);
  }

  // 縦位置: 名前の字面が上下に跳ばない。input 要素の高さ(≒フォントの行高)は枠(ROW_HEIGHT)より
  // 小さく枠内で中央寄せされるため、上端同士ではなく中心同士を比べる(表示側 Typography も
  // lineHeight: ROW_HEIGHT で帯の中央に字を置いている)。
  const centerY = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(
    Math.abs(centerY(after.name!) - centerY(before.name!)),
    `名前の字面の中心が表示と一致 (表示=${centerY(before.name!)} 編集=${centerY(after.name!)})`,
  ).toBeLessThanOrEqual(TOL);
  expect(
    Math.abs(centerY(after.type!) - centerY(before.type!)),
    `型の字面の中心が表示と一致 (表示=${centerY(before.type!)} 編集=${centerY(after.type!)})`,
  ).toBeLessThanOrEqual(TOL);

  // note の縦位置: 表示側は1行目を名前・型の帯に中央合わせする上余白を持つ。編集側の入力欄が
  // これを持たないと note の字だけが編集開始で上に跳ぶ(x とグリッド高は一致したままなので、
  // ここを見ないと気づけない)。
  expect(
    Math.abs(after.note!.y - before.noteFirstLineY),
    `note の1行目の上端が表示と一致 (表示=${before.noteFirstLineY} 編集=${after.note!.y})`,
  ).toBeLessThanOrEqual(TOL);
  // 名前入力欄の高さが表示行1行分(ROW_HEIGHT=26)相当に収まっている。
  expect(after.name!.height, `名前入力欄が表示行1行分の高さ (${after.name!.height})`).toBeLessThanOrEqual(
    before.row.height + 1,
  );
});

test('複数行 note の行でも編集行が表示行の高さを保つ', async ({ page }) => {
  await installTauriMock(page, { files: { [MULTILINE_PATH]: MULTILINE_SRC }, dialogPath: MULTILINE_PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home');
  await node.locator('.table-drag-handle').click();

  // 3行 note で縦に伸びている表示行の高さを測る。
  const noteCell = node.locator('[data-cell="note"]').nth(1);
  const rowBefore = await noteCell.evaluate((el) => {
    const r = (el.parentElement as HTMLElement).getBoundingClientRect();
    return { y: r.y, height: r.height };
  });

  await noteCell.dblclick();
  const noteField = node.getByPlaceholder('note');
  await expect(noteField).toBeVisible();
  await expect(noteField).toHaveValue('区分\n0:未\n1:済');
  await node.screenshot({ path: 'e2e/__screenshots__/edit-row-align-multiline.png' });

  // 編集行の1段目(名前入力欄を含むグリッド)の高さが、元の表示行の高さとほぼ同じ。
  const gridAfter = await node.getByPlaceholder('カラム名').evaluate((el) => {
    // input → OutlinedInput root → TextField root → 1段目グリッド
    const grid = el.closest('.MuiFormControl-root')!.parentElement as HTMLElement;
    const r = grid.getBoundingClientRect();
    return { y: r.y, height: r.height };
  });
  expect(
    Math.abs(gridAfter.height - rowBefore.height),
    `編集行1段目が表示行と同じ高さ (表示=${rowBefore.height} 編集=${gridAfter.height})`,
  ).toBeLessThanOrEqual(3);
  expect(
    Math.abs(gridAfter.y - rowBefore.y),
    `編集行1段目の上端が表示行と同位置 (表示=${rowBefore.y} 編集=${gridAfter.y})`,
  ).toBeLessThanOrEqual(3);
});

// note 列を持たず、かつカラム名が極端に短いテーブル。ここが2つの分岐の同時確認になる:
// (1) 追加(insert)行のパス、(2) note が1段目でなく補助段へ回るパス。
// 列幅の下限(nodeSize の MIN_*_COL_WIDTH)が無いと、入力欄が数pxまで潰れて操作できなくなる。
const SHORT_PATH = '/Users/test/short.dbml';
const SHORT_SRC = `Table T {
  "id" int [pk]
  "no" int
}
`;

test('短いカラム名・note列なしのテーブルでも追加行の入力欄が潰れない', async ({ page }) => {
  await installTauriMock(page, { files: { [SHORT_PATH]: SHORT_SRC }, dialogPath: SHORT_PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home');
  await node.locator('.table-drag-handle').click();

  // ヘッダーの [+] で末尾に追加行を開く(rowHeight=ROW_HEIGHT を渡すパス)。
  await node.locator('button[aria-label="末尾にカラムを追加"]').click();
  const nameField = node.getByPlaceholder('カラム名');
  await expect(nameField).toBeVisible();
  await node.screenshot({ path: 'e2e/__screenshots__/edit-row-align-short.png' });

  // note 列が無いテーブルなので、note は1段目ではなく補助段(default の隣)に出る。
  await expect(node.getByPlaceholder('note')).toBeVisible();
  await expect(node.getByPlaceholder('default')).toBeVisible();

  // 入力欄が実用的な幅を持つ(プレースホルダが読める程度)。
  const nameBox = await nameField.boundingBox();
  const typeBox = await node.getByPlaceholder('型').boundingBox();
  expect(nameBox!.width, `名前入力欄の幅 (${nameBox!.width})`).toBeGreaterThanOrEqual(70);
  expect(typeBox!.width, `型入力欄の幅 (${typeBox!.width})`).toBeGreaterThanOrEqual(50);

  // 入力した値がそのまま確定でき、保存内容にも反映される(潰れた欄で操作不能になっていない)。
  await nameField.fill('memo');
  await node.getByPlaceholder('型').fill('varchar');
  await page.keyboard.press('Enter');
  await expect(nameField).toBeHidden();

  await page.locator('button[aria-label="保存"]').click();
  await expect
    .poll(() => page.evaluate((p) => window.__mockState.files[p], SHORT_PATH))
    .toBe(`Table T {
  "id" int [pk]
  "no" int
  "memo" varchar
}
`);
});

// 大文字英字+日本語のカラム名(旧: 文字数概算が実描画より狭く出る代表例)と長い note。
// 列幅を canvas 実測ベースへ移行(2026-07-14)した後の確認用。
const WIDE_PATH = '/Users/test/wide.dbml';
const WIDE_SRC = `Table T {
  "HKD商品CD" bigint [pk]
  "HKDメンテナンス数" "decimal(10,0)" [not null, default: '0', note: '検品数のうち、何個がメンテナンスされたか']
}
`;

test('実測ベースの列幅: 大文字英字+日本語の名前が表示・編集とも見切れない', async ({ page }) => {
  await installTauriMock(page, { files: { [WIDE_PATH]: WIDE_SRC }, dialogPath: WIDE_PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home');

  // 表示: 名前・型セルが省略(…)されていない。
  const displayClipped = await node.evaluate((root) =>
    Array.from(root.querySelectorAll('[data-cell="name"], [data-cell="type"]')).map((el) => ({
      text: el.textContent,
      clipped: el.scrollWidth > (el as HTMLElement).clientWidth,
    })),
  );
  for (const cell of displayClipped) {
    expect(cell.clipped, `表示セル "${cell.text}" が省略されていない`).toBe(false);
  }

  // 編集: 名前・型の入力欄でも全文が収まる。
  const noteCellWidth = (await node.locator('[data-cell="note"]').nth(1).boundingBox())!.width;
  await node.locator('[data-cell="name"]').nth(1).dblclick();
  const nameField = node.getByPlaceholder('カラム名');
  await expect(nameField).toHaveValue('HKDメンテナンス数');
  for (const [label, locator] of [
    ['名前', nameField],
    ['型', node.getByPlaceholder('型')],
  ] as const) {
    const overflow = await locator.evaluate((el: HTMLInputElement) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `${label}: 入力欄で全文が収まる (内容=${overflow.scrollWidth} 枠=${overflow.clientWidth})`,
    ).toBeLessThanOrEqual(overflow.clientWidth);
  }

  // 長い note(列上限180px超)の編集欄は、行の右端側(ガター分)へ延長されて広くなる。
  const noteFieldWidth = (await node.getByPlaceholder('note').boundingBox())!.width;
  expect(
    noteFieldWidth,
    `note編集欄が表示セルより広い (表示=${noteCellWidth} 編集=${noteFieldWidth})`,
  ).toBeGreaterThanOrEqual(noteCellWidth + 50);

  await node.screenshot({ path: 'e2e/__screenshots__/edit-row-align-wide.png' });
});

test('編集中に長い文字を打つと列ごとライブで広がり、テキストが切れない', async ({ page }) => {
  await installTauriMock(page, { files: { [SHORT_PATH]: SHORT_SRC }, dialogPath: SHORT_PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home');
  await node.locator('.table-drag-handle').click();

  const boxBefore = await node.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().width);

  // 編集開始し、列幅(最小80px)を大きく超える名前を打つ。
  await node.locator('[data-cell="name"]').nth(1).dblclick();
  const nameField = node.getByPlaceholder('カラム名');
  await expect(nameField).toBeVisible();
  const LONG = 'とても長いカラム名で幅を超える例';
  await nameField.fill(LONG);

  // 1) 入力欄が内容ぶんに広がり、テキストが切れない(横スクロールしていない)。
  await expect
    .poll(async () =>
      nameField.evaluate((el: HTMLInputElement) => ({
        clipped: el.scrollWidth > el.clientWidth,
        width: el.clientWidth,
      })),
    )
    .toMatchObject({ clipped: false });

  // 2) 表示行(1行目 "id")の名前セルも同じ幅に広がっている(列位置が揃ったまま)。
  const nameFieldWidth = await nameField.evaluate((el: HTMLInputElement) => el.clientWidth);
  const displayNameWidth = await node
    .locator('[data-cell="name"]')
    .first()
    .evaluate((el) => (el as HTMLElement).clientWidth);
  expect(
    Math.abs(displayNameWidth - nameFieldWidth),
    `表示行の名前セルも同じ幅 (表示=${displayNameWidth} 編集=${nameFieldWidth})`,
  ).toBeLessThanOrEqual(1);

  // 3) 箱もはみ出さず追従して広がっている。
  // React Flow のラッパー(.react-flow__node)は親の style.width のままなので、
  // previewWidth が効く内側の Box(overflow:hidden の箱)を測る。
  const innerBoxWidth = () =>
    node.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().width);
  const boxDuring = await innerBoxWidth();
  expect(boxDuring, `箱幅が広がる (前=${boxBefore} 編集中=${boxDuring})`).toBeGreaterThan(boxBefore + 50);
  // 入力欄が箱の内側に収まっている(overflow:hidden で右端が切れていない)。
  const nameRight = await nameField.evaluate((el) => el.getBoundingClientRect().right);
  const boxRight = await node.evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().right);
  expect(nameRight, `入力欄が箱の内側 (入力右端=${nameRight} 箱右端=${boxRight})`).toBeLessThanOrEqual(boxRight);
  // node(ラッパー)は元幅のままなので、広がった内側の Box を撮る。
  await node.locator(':scope > div').first().screenshot({ path: 'e2e/__screenshots__/edit-row-align-grow.png' });

  // 4) Esc で破棄すると元の幅へ戻る。
  await page.keyboard.press('Escape');
  await expect(nameField).toBeHidden();
  await expect
    .poll(innerBoxWidth, { message: '破棄で列も箱も元に戻る' })
    .toBeCloseTo(boxBefore, 0);
});
