import { test, expect } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// 履歴機能(最近開いたファイル)の実行時挙動を、フロント+Tauri IPCモックで検証する。
// - 履歴0件では履歴ボタンが無効
// - ダイアログで開くと履歴に積まれ、ボタンから開ける(フルパス表示)
// - 欠損ファイルを履歴から選ぶとトースト通知して履歴から除去される
// - localStorage(jpdbml.recentFiles)に永続する

const DBML_A = 'Table users {\n  id int [pk]\n  name varchar\n}\n';
const DBML_B = 'Table orders {\n  id int [pk]\n  user_id int\n}\n';
const PATH_A = '/Users/test/projects/alpha/schema_a.dbml';
const PATH_B = '/Users/test/projects/beta/schema_b.dbml';

const HISTORY_BTN = 'button[aria-label="最近開いたファイル"]';
const OPEN_BTN = 'button[aria-label="DBMLファイルを開く"]';

test.beforeEach(async ({ page }) => {
  // 各テストは履歴を空から始める(localStorageは新規コンテキストで既に空だが明示)。
  await page.addInitScript(() => localStorage.removeItem('jpdbml.recentFiles'));
});

test('履歴0件では履歴ボタンが無効', async ({ page }) => {
  await installTauriMock(page, { files: {} });
  await page.goto('/');
  await expect(page.locator(HISTORY_BTN)).toBeDisabled();
});

test('ダイアログで開く→履歴に積まれ、履歴ボタンからフルパスで開ける', async ({ page }) => {
  // 1回目: ダイアログで PATH_A を開く
  await installTauriMock(page, { files: { [PATH_A]: DBML_A, [PATH_B]: DBML_B }, dialogPath: PATH_A });
  await page.goto('/');

  await page.locator(OPEN_BTN).click();
  // 開けたことをステータスバー等ではなく履歴ボタンの活性化で観測(履歴に積まれた=有効化)。
  await expect(page.locator(HISTORY_BTN)).toBeEnabled();

  // 履歴メニューにフルパスが1件表示される
  await page.locator(HISTORY_BTN).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: PATH_A })).toBeVisible();

  // localStorage 永続を確認
  const stored = await page.evaluate(() => localStorage.getItem('jpdbml.recentFiles'));
  expect(JSON.parse(stored!)).toEqual([PATH_A]);
});

test('別ファイルを開くと履歴が新しい順に積まれ、履歴から選んで開ける', async ({ page }) => {
  // PATH_A を先に履歴へ入れた状態で起動し、ダイアログでは PATH_B を返す設定にする。
  await page.addInitScript(
    (p) => localStorage.setItem('jpdbml.recentFiles', JSON.stringify([p])),
    PATH_A,
  );
  await installTauriMock(page, { files: { [PATH_A]: DBML_A, [PATH_B]: DBML_B }, dialogPath: PATH_B });
  await page.goto('/');

  // 起動直後は履歴1件(PATH_A)。ダイアログで PATH_B を開く。
  await page.locator(OPEN_BTN).click();

  await page.locator(HISTORY_BTN).click();
  const items = page.getByRole('menu').getByRole('menuitem');
  await expect(items).toHaveCount(2);
  // 新しい順: 先頭が PATH_B
  await expect(items.nth(0)).toHaveAccessibleName(PATH_B);
  await expect(items.nth(1)).toHaveAccessibleName(PATH_A);

  // 履歴の PATH_A を選んで開く → PATH_A が先頭へ繰り上がる
  await items.nth(1).click();
  await page.locator(HISTORY_BTN).click();
  const items2 = page.getByRole('menu').getByRole('menuitem');
  await expect(items2.nth(0)).toHaveAccessibleName(PATH_A);
  await expect(items2.nth(1)).toHaveAccessibleName(PATH_B);
});

test('欠損ファイルを履歴から選ぶ→トースト通知して履歴から除去', async ({ page }) => {
  // 履歴には PATH_A と「存在しない」PATH_B が入っているが、仮想FSには PATH_A しか無い。
  await page.addInitScript(
    (paths) => localStorage.setItem('jpdbml.recentFiles', JSON.stringify(paths)),
    [PATH_B, PATH_A],
  );
  await installTauriMock(page, { files: { [PATH_A]: DBML_A } /* PATH_B は欠損 */ });
  await page.goto('/');

  await page.locator(HISTORY_BTN).click();
  // 先頭(PATH_B, 欠損)を選ぶ
  await page.getByRole('menu').getByRole('menuitem', { name: PATH_B }).click();

  // トースト通知(notistack)
  await expect(page.getByText('ファイルが見つかりませんでした。履歴から削除します。')).toBeVisible();

  // 履歴から PATH_B が除去され、PATH_A のみ残る
  await page.locator(HISTORY_BTN).click();
  const items = page.getByRole('menu').getByRole('menuitem');
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toHaveAccessibleName(PATH_A);

  const stored = await page.evaluate(() => localStorage.getItem('jpdbml.recentFiles'));
  expect(JSON.parse(stored!)).toEqual([PATH_A]);
});
