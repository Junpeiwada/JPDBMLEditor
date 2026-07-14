import { test, expect } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// カラムnoteの複数行編集: Excelと同じ Alt(Option)+Enter でセル内改行、Enter で確定。
// 確定後の保存で DBML 側にはリテラル `\n` として書かれること(既存データの流儀)まで確認する。
const PATH = '/Users/test/mini.dbml';
const SRC = `Table T {
  "id" int [pk]
  "st" int [note: '区分']
}
`;

test('note: Alt+Enter でセル内改行して保存できる', async ({ page }) => {
  await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH });
  await page.goto('/');
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();

  const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
  await node.waitFor({ timeout: 30_000 });
  // LOD(縮小時の省略表示)を無効にしてカラム行を必ず描かせる。
  await page.getByRole('slider').press('Home');

  // note セルをダブルクリックして編集行を開く(noteに初期フォーカスが当たる)。
  // 2行目("st" カラム)の note セル。1行目("id")の note は空セルで表示領域を持たない。
  const stNote = node.locator('[data-cell="note"]').nth(1);
  await stNote.dblclick();
  const noteField = page.getByPlaceholder('note');
  await expect(noteField).toBeVisible();
  await expect(noteField).toHaveValue('区分');

  // Alt+Enter でセル内改行 → 2行目を入力。Enter は確定なので改行には使わない。
  await noteField.fill('0:未');
  await page.keyboard.press('Alt+Enter');
  await noteField.pressSequentially('1:済');
  await expect(noteField, 'Alt+Enter でテキストエリアに実改行が入る').toHaveValue('0:未\n1:済');

  // Enter で確定 → 編集行が閉じる。
  await page.keyboard.press('Enter');
  await expect(noteField).toBeHidden();

  // 表示が2行になり、両行とも行の高さに収まっている(切れていない)。
  const cell = node.locator('[data-cell="note"]').nth(1);
  const shown = await cell.evaluate((el) => {
    const lines = Array.from(el.children) as HTMLElement[];
    const rowH = (el.parentElement as HTMLElement).getBoundingClientRect().height;
    const contentH = lines.reduce((a, l) => a + l.getBoundingClientRect().height, 0);
    return { texts: lines.map((l) => l.textContent), rowH, contentH };
  });
  expect(shown.texts).toEqual(['0:未', '1:済']);
  expect(shown.contentH, '2行が行高に収まる(切れない)').toBeLessThanOrEqual(shown.rowH + 0.5);

  // 保存すると、DBML上はリテラル `\n` として1行に書かれる(既存データの流儀)。
  await page.locator('button[aria-label="保存"]').click();
  await expect
    .poll(() => page.evaluate((p) => window.__mockState.files[p], PATH), {
      message: 'セル内改行は DBML 上ではリテラル \\n として書かれる',
    })
    .toBe(`Table T {
  "id" int [pk]
  "st" int [note: '0:未\\n1:済']
}
`);
});
