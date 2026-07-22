import { test, expect } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// 自動アップデート(useAppUpdater + TopBar の更新ボタン)の確認。
//
// isTauri() は window.isTauri フラグで判定される。installTauriMock は updateAvailable キーを
// 渡したテストでのみ isTauri=true にするため、
//  - updateAvailable 未指定: 非 Tauri 経路(updater を呼ばず「利用できません」)
//  - updateAvailable 指定  : Tauri 経路(check() が走り、あり/なしを切り替えられる)
// を撃ち分けられる。実ダウンロード〜再起動は実ランタイム前提なので再現しない。
const PATH = '/Users/test/u.dbml';
const SRC = `Table T {
  "id" int [pk]
}
`;

test('トップバーに更新ボタンがあり、非Tauri環境で押してもアプリが落ちない', async ({ page }) => {
  // updateAvailable を渡さない = 非 Tauri 環境(素のブラウザ相当)。
  await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH });
  await page.goto('/');

  // 起動時の自動チェックが走る(useAppUpdater の useEffect)。落ちなければ描画は継続する。
  const updateBtn = page.locator('button[aria-label="アップデートを確認"]');
  await expect(updateBtn, '更新ボタンが表示される').toBeVisible();

  // 手動チェック。非 Tauri なので「利用できません」を通知し、例外で画面を壊さない。
  await updateBtn.click();
  await expect(page.getByText('この環境では更新チェックは利用できません')).toBeVisible({ timeout: 10_000 });

  // ファイルを開く動線が引き続き機能する(GUI が生きている証跡)。
  await page.locator('button[aria-label="DBMLファイルを開く"]').click();
  await page.locator('.react-flow__node', { hasText: 'T' }).first().waitFor({ timeout: 30_000 });
});

test('更新なし(Tauri)なら手動チェックで「最新版」を通知する', async ({ page }) => {
  await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH, updateAvailable: null });
  await page.goto('/');

  const updateBtn = page.locator('button[aria-label="アップデートを確認"]');
  await updateBtn.click();
  await expect(page.getByText('最新版を使用しています')).toBeVisible({ timeout: 10_000 });
});

test('更新あり(Tauri)なら「今すぐ更新/後で」を出し、「後で」で Update を解放する', async ({ page }) => {
  await installTauriMock(page, {
    files: { [PATH]: SRC },
    dialogPath: PATH,
    updateAvailable: { version: '9.9.9' },
  });
  await page.goto('/');

  // 起動時の自動チェックで更新ありを検知し、新バージョンのトーストが出る。
  await expect(page.getByText('新しいバージョン 9.9.9 があります')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '今すぐ更新' })).toBeVisible();

  // 「後で」を押すと、使わない Update をネイティブ側で解放する(plugin:resources|close)。
  await page.getByRole('button', { name: '後で' }).click();
  const closed = await page.evaluate(() =>
    window.__mockState.calls.some((c) => c.cmd === 'plugin:resources|close'),
  );
  expect(closed, '「後で」で Update.close() が呼ばれる').toBe(true);

  // 「後で」でロックが確実に解放され、再チェックできる(デッドロックしない)。
  // 更新ボタンは有効に戻り、押すと 2 回目の check() が走る。
  const updateBtn = page.locator('button[aria-label="アップデートを確認"]');
  await expect(updateBtn, '「後で」後は更新ボタンが有効に戻る').toBeEnabled();
  const checksBefore = await page.evaluate(
    () => window.__mockState.calls.filter((c) => c.cmd === 'plugin:updater|check').length,
  );
  await updateBtn.click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__mockState.calls.filter((c) => c.cmd === 'plugin:updater|check').length,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(checksBefore);
});

test('更新あり(Tauri)で「今すぐ更新」を押すとダウンロード→再起動まで進む', async ({ page }) => {
  await installTauriMock(page, {
    files: { [PATH]: SRC },
    dialogPath: PATH,
    updateAvailable: { version: '9.9.9' },
  });
  await page.goto('/');

  await page.getByRole('button', { name: '今すぐ更新' }).click();

  // downloadAndInstall(plugin:updater|download_and_install) → relaunch(plugin:process|restart)
  // の順で進み、例外で止まらないこと。
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          downloaded: window.__mockState.calls.some(
            (c) => c.cmd === 'plugin:updater|download_and_install',
          ),
          restarted: window.__mockState.calls.some((c) => c.cmd === 'plugin:process|restart'),
        })),
      { timeout: 10_000 },
    )
    .toEqual({ downloaded: true, restarted: true });
});
