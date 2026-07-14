import { defineConfig, devices } from '@playwright/test';

// Tauri アプリのフロント(Vite)を Chromium で開き、Tauri の IPC(window.__TAURI_INTERNALS__)を
// テスト側でモックして実行時挙動を検証する構成。実 Tauri ウィンドウ(WKWebView)は macOS では
// WebDriver 非対応のため、フロント+IPCモックで UI とロジックの実行時挙動を観測する。
//
// webServer は専用ポート(1421)で dev サーバを起動し、開発中の 1420 と衝突させない。
const PORT = 1421;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
