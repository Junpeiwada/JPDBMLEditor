import { test, expect } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// 左サイドパネルのテーブル一覧2カラム化とレイアウト調整の実行時挙動を検証する。
// - テーブル名と日本語名(noteの1行目)が別カラムで表示され、カラム数 (N) は表示されない
// - ヘッダー行の境界ドラッグでテーブル名カラムの幅が変わり、localStorage に永続する
// - パネル右端のドラッグでパネル幅が変わり、localStorage に永続する
// - リロード後も保存された幅が復元される

const DBML = [
  'Table users {',
  '  id int [pk]',
  '  name varchar',
  "  Note: '''ユーザーマスタ",
  "2行目は出ない'''",
  '}',
  '',
  'Table orders {',
  '  id int [pk]',
  '}',
  '',
].join('\n');
const PATH = '/Users/test/projects/alpha/schema.dbml';

const OPEN_BTN = 'button[aria-label="DBMLファイルを開く"]';
const PANEL_HANDLE = '[role="separator"][aria-label="パネルの幅を調整"]';
const COL_HANDLE = '[role="separator"][aria-label="テーブル名カラムの幅を調整"]';

/** ハンドルを水平に dx ピクセルだけドラッグする。 */
async function dragHorizontal(page: import('@playwright/test').Page, selector: string, dx: number) {
  const handle = page.locator(selector);
  const box = (await handle.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY, { steps: 5 });
  await page.mouse.up();
}

async function openSample(page: import('@playwright/test').Page) {
  await installTauriMock(page, { files: { [PATH]: DBML }, dialogPath: PATH });
  await page.goto('/');
  await page.locator(OPEN_BTN).click();
  await page.locator('.react-flow__node', { hasText: 'users' }).first().waitFor({ timeout: 30_000 });
}

test('テーブル名と日本語名が別カラムで表示され、カラム数は表示されない', async ({ page }) => {
  await openSample(page);

  // ヘッダー行のラベル
  await expect(page.getByText('テーブル名', { exact: true })).toBeVisible();
  await expect(page.getByText('日本語名', { exact: true })).toBeVisible();

  // users 行: テーブル名セルと日本語名セル(noteの1行目のみ)が横並びで表示される
  const usersRow = page.getByRole('button', { name: /users/ });
  await expect(usersRow.getByText('users', { exact: true })).toBeVisible();
  await expect(usersRow.getByText('ユーザーマスタ')).toBeVisible();
  await expect(usersRow.getByText('2行目は出ない')).toHaveCount(0);

  // カラム数 (N) は表示されない(users は2カラムなので旧表記は "(2)")
  await expect(usersRow.getByText('(2)')).toHaveCount(0);

  // 日本語名セルはテーブル名セルの右にある(同じ行内で x 座標が大きい)
  const nameBox = (await usersRow.getByText('users', { exact: true }).boundingBox())!;
  const noteBox = (await usersRow.getByText('ユーザーマスタ').boundingBox())!;
  expect(noteBox.x).toBeGreaterThan(nameBox.x + nameBox.width - 1);
});

test('境界ドラッグでカラム幅・パネル幅が変わり、localStorage に永続してリロード後も復元される', async ({
  page,
}) => {
  await openSample(page);

  // 初期状態の確認用に users テーブル名セルの幅を取る(既定 110px)
  const usersName = page.getByRole('button', { name: /users/ }).getByText('users', { exact: true });
  const nameBefore = (await usersName.boundingBox())!;

  // まずパネルを広げる(+120px)。カラム幅を広げる余地を確保してから境界を動かす。
  const panel = page.locator(PANEL_HANDLE);
  const panelBefore = (await panel.boundingBox())!;
  await dragHorizontal(page, PANEL_HANDLE, 120);
  const panelAfter = (await panel.boundingBox())!;
  expect(panelAfter.x - panelBefore.x).toBeGreaterThan(100);

  // カラム境界を +60px ドラッグ → テーブル名セルが広がる
  await dragHorizontal(page, COL_HANDLE, 60);
  const nameAfter = (await usersName.boundingBox())!;
  expect(nameAfter.width - nameBefore.width).toBeGreaterThan(40);

  // localStorage へ永続している
  const storedPanel = await page.evaluate(() => localStorage.getItem('jpdbml.panelWidth'));
  const storedCol = await page.evaluate(() => localStorage.getItem('jpdbml.panelNameColWidth'));
  expect(Number(storedPanel)).toBeGreaterThan(300); // 220 + 120
  expect(Number(storedCol)).toBeGreaterThan(150); // 110 + 60

  // リロード → 保存された幅で復元される(ファイルは開き直す)
  await page.goto('/');
  await page.locator(OPEN_BTN).click();
  await page.locator('.react-flow__node', { hasText: 'users' }).first().waitFor({ timeout: 30_000 });
  const panelRestored = (await page.locator(PANEL_HANDLE).boundingBox())!;
  expect(Math.abs(panelRestored.x - panelAfter.x)).toBeLessThan(3);
  const nameRestored = (await usersName.boundingBox())!;
  expect(Math.abs(nameRestored.width - nameAfter.width)).toBeLessThan(3);
});
