import { test } from '@playwright/test';
import { installTauriMock } from './tauriMock';

// レビュー用スクリーンショット: 履歴メニューにフルパスが2件並んだ状態を1枚撮る。
test('capture: 履歴メニュー表示', async ({ page }) => {
  await page.addInitScript(
    (paths) => localStorage.setItem('jpdbml.recentFiles', JSON.stringify(paths)),
    ['/Users/test/projects/beta/schema_b.dbml', '/Users/test/projects/alpha/schema_a.dbml'],
  );
  await installTauriMock(page, { files: {} });
  await page.goto('/');
  await page.locator('button[aria-label="最近開いたファイル"]').click();
  await page.getByRole('menu').waitFor();
  await page.screenshot({ path: 'e2e/__screenshots__/recent-menu.png' });
});
