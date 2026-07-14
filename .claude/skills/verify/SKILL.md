---
name: verify
description: JPDBMLEditor の変更を実際に動かして確認する(Playwright + Tauri IPC モックで GUI を駆動)
---

# JPDBMLEditor の動作確認

このアプリの表面は **GUI(ピクセル)**。`npm run tauri dev` の実ウィンドウは macOS の WKWebView が
WebDriver 非対応で自動操作できないため、**Vite フロント + Tauri IPC モック(Chromium)** で駆動する。
これが唯一の自動化された観測手段。

## 駆動する

```bash
npx playwright test                          # 全件(dev サーバは webServer が自動起動)
npx playwright test e2e/column-move.spec.ts  # 単体
```

`playwright.config.ts` が専用ポート **1421** で dev サーバを立てる(開発中の 1420 と衝突しない)。
別途 `npm run dev` を起動しておく必要はない。

## 定型パターン

`e2e/tauriMock.ts` の `installTauriMock(page, { files, dialogPath })` を **`page.goto` の前に**呼ぶ。
`window.__TAURI_INTERNALS__.invoke` を差し替えるので fs/dialog がまるごとモックされる。

```ts
await installTauriMock(page, { files: { [PATH]: SRC }, dialogPath: PATH });
await page.goto('/');
await page.locator('button[aria-label="DBMLファイルを開く"]').click();
const node = page.locator('.react-flow__node', { hasText: 'T' }).first();
await node.waitFor({ timeout: 30_000 });
await page.getByRole('slider').press('Home');   // LOD を無効化(これが無いとカラム行が描かれない)
await node.locator('.table-drag-handle').click(); // フォーカスモードへ(編集系UIはここでのみ出る)
```

### 落とし穴

- **LOD**: 縮小時はカラム行を描かない。カラムに触るテストは必ず `getByRole('slider').press('Home')`。
- **編集系UIはフォーカス起点テーブルのみ**。`.table-drag-handle` をクリックしてフォーカスに入る。
- **保存ボタンは未編集だと disabled**。先に何か編集してから押す。
- **書き出したテキストの観測**: `window.__mockState.files[パス]` に実際の保存内容が入る
  (write_text_file は本文=Uint8Array・パス=第3引数 `{headers:{path}}`(URLエンコード)という
  特殊な渡し方をするが、モック側で復元済み)。`calls` にはコマンド履歴が入る。
- **`getByText('フォーカス')` は曖昧**(サイドパネルの見出しと衝突)。`getByText('フォーカス: T')` を使う。

## 最小編集ロジックの実データ確認

`src/edit/*.verify.mts` は SampleDBML の実データ全件に純関数を当てる確認スクリプト。
GUI 駆動の代わりにはならないが、書式保持の網羅確認に使える。

```bash
node --experimental-strip-types src/edit/moveColumn.verify.mts SampleDBML/<サンプル>.dbml
```

## スクリーンショット

`page.screenshot({ path: 'e2e/__screenshots__/x.png' })`。ノード単体なら `node.screenshot(...)` が
細部(行内のボタン等)を見るのに向く。
