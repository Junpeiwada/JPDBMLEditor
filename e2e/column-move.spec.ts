import { test, expect } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// カラム並べ替え(▲▼): フォーカスモードの起点テーブルでのみ、行ホバーで右端にボタンが出る。
// 1クリック=1行移動。属性・行末コメントは行ごと移動し、他の行は一切変わらない(最小編集)。
const PATH = '/Users/test/move.dbml';
const SRC = `Table T {
  "id" int [pk, note: 'ID']
  "name" nvarchar(100) [not null, note: '名前'] // 行末コメント
  "age" int
}

Table Other {
  "id" int [pk]
}
`;

/** ファイルを開き、LODを無効化してカラム行を必ず描かせる。 */
async function open(page: import('@playwright/test').Page) {
  await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();
  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home');
  return node;
}

/** テーブルノードのカラム名を上から順に返す(表示順=モデル順)。 */
async function columnNames(node: import('@playwright/test').Locator) {
  return node.locator('[data-cell="name"]').allTextContents();
}

test('フォーカス起点でのみ ▲▼ が出て、1クリックで1行移動する', async ({ page }) => {
  const node = await open(page);
  const nameRow = node.locator('[data-cell="name"]', { hasText: 'name' });

  // --- 全体モードでは ▲▼ を出さない(図が汚れない) ---
  await nameRow.hover();
  await expect(
    node.locator('button[aria-label="カラムを下へ移動"]'),
    '全体モードでは並べ替えボタンを出さない',
  ).toHaveCount(0);

  // --- テーブルをクリックしてフォーカスモードへ ---
  await node.locator('.table-drag-handle').click();
  await expect(page.getByText('フォーカス: T'), 'モード表示がフォーカスになる').toBeVisible();

  // --- 行ホバーで ▲▼ が現れる ---
  const downBtn = node.locator('button[aria-label="カラムを下へ移動"]').nth(1); // name 行
  await nameRow.hover();
  await expect(downBtn, 'フォーカス起点の行ホバーで ▼ が可視になる').toBeVisible();

  expect(await columnNames(node)).toEqual(['id', 'name', 'age']);

  // --- ▼ を1回クリック → name が1行下がる ---
  await downBtn.click();
  await expect
    .poll(() => columnNames(node), { message: '▼ 1回で1行だけ下がる' })
    .toEqual(['id', 'age', 'name']);

  // --- ▲ で押し戻すと元に戻る ---
  const nameRow2 = node.locator('[data-cell="name"]', { hasText: 'name' });
  await nameRow2.hover();
  await node.locator('button[aria-label="カラムを上へ移動"]').nth(2).click();
  await expect.poll(() => columnNames(node), { message: '▲ で元の並びに戻る' }).toEqual(['id', 'name', 'age']);
});

test('端のボタンは disabled(先頭の▲ / 末尾の▼)', async ({ page }) => {
  const node = await open(page);
  await node.locator('.table-drag-handle').click();

  await node.locator('[data-cell="name"]', { hasText: 'id' }).hover();
  await expect(node.locator('button[aria-label="カラムを上へ移動"]').first(), '先頭カラムの▲は押せない').toBeDisabled();
  await expect(node.locator('button[aria-label="カラムを下へ移動"]').first(), '先頭カラムの▼は押せる').toBeEnabled();

  await node.locator('[data-cell="name"]', { hasText: 'age' }).hover();
  await expect(node.locator('button[aria-label="カラムを下へ移動"]').nth(2), '末尾カラムの▼は押せない').toBeDisabled();
});

test('▲▼ クリックが行選択/編集開始を誘発しない', async ({ page }) => {
  const node = await open(page);
  await node.locator('.table-drag-handle').click();

  await node.locator('[data-cell="name"]', { hasText: 'name' }).hover();
  await node.locator('button[aria-label="カラムを下へ移動"]').nth(1).click();

  // 行の onClick(行選択)や onDoubleClick(編集行を開く)に吸われていないこと。
  await expect(page.getByPlaceholder('note'), '移動クリックで編集行が開かない').toBeHidden();
});

test('移動は Undo/Redo できる', async ({ page }) => {
  const node = await open(page);
  await node.locator('.table-drag-handle').click();

  await node.locator('[data-cell="name"]', { hasText: 'name' }).hover();
  await node.locator('button[aria-label="カラムを下へ移動"]').nth(1).click();
  await expect.poll(() => columnNames(node)).toEqual(['id', 'age', 'name']);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => columnNames(node), { message: 'Undo で移動前の並びに戻る' }).toEqual(['id', 'name', 'age']);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => columnNames(node), { message: 'Redo で再び移動後の並びになる' }).toEqual(['id', 'age', 'name']);
});

test('クリック後はフォーカスが移動したカラムに追従し、Enter 連打で同じカラムが動き続ける', async ({ page }) => {
  const node = await open(page);
  await node.locator('.table-drag-handle').click();

  await node.locator('[data-cell="name"]', { hasText: 'id' }).hover();
  await node.locator('button[aria-label="カラムを下へ移動"]').first().click();
  await expect.poll(() => columnNames(node)).toEqual(['name', 'id', 'age']);

  // 行(key=col.id)ごと DOM が移動するため、フォーカスも移動したカラムの ▼ に残る。
  // そのため Enter を押し続けると「同じカラム」が下がり続ける(マウス連打と違い発散しない)。
  await page.keyboard.press('Enter');
  await expect
    .poll(() => columnNames(node), { message: 'Enter 連打では同じカラム(id)が下がり続ける' })
    .toEqual(['name', 'age', 'id']);
});

test('FK カラムを移動してもリレーション線が消えない', async ({ page }) => {
  await installTauriMock(page, {
    files: {
      [PATH]: `Table users {
  "id" int [pk]
  "name" nvarchar(100)
}

Table orders {
  "id" int [pk]
  "user_id" int [not null]
}

Ref: orders.user_id > users.id
`,
    },
    dialogPath: PATH,
  });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();
  const orders = page.locator('.react-flow__node', { hasText: 'orders' }).first();
  await orders.waitFor({ timeout: 30_000 });
  await page.getByRole('slider').press('Home');
  await orders.locator('.table-drag-handle').click();

  await orders.locator('[data-cell="name"]', { hasText: 'user_id' }).hover();
  await orders.locator('button[aria-label="カラムを上へ移動"]').nth(1).click();
  await expect.poll(() => columnNames(orders)).toEqual(['user_id', 'id']);
  await expect(page.locator('.react-flow__edge'), 'FK行の移動後もリレーション線が残る').toHaveCount(1);
});

test('移動しても属性・行末コメントが行ごと移動し、他の行は変わらない', async ({ page }) => {
  const node = await open(page);
  await node.locator('.table-drag-handle').click();

  await node.locator('[data-cell="name"]', { hasText: 'name' }).hover();
  await node.locator('button[aria-label="カラムを下へ移動"]').nth(1).click();
  await expect.poll(() => columnNames(node)).toEqual(['id', 'age', 'name']);

  // 保存して、実際にディスクへ書き出されるテキストそのものを観測する。
  await page.locator('button[aria-label="保存"]').click();
  await expect
    .poll(() => page.evaluate((p) => window.__mockState.files[p], PATH), {
      message: '移動した行が属性・行末コメントごと丸ごと入れ替わり、他の行は1文字も変わらない',
    })
    .toBe(`Table T {
  "id" int [pk, note: 'ID']
  "age" int
  "name" nvarchar(100) [not null, note: '名前'] // 行末コメント
}

Table Other {
  "id" int [pk]
}
`);
});
