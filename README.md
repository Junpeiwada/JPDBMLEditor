# JPDBMLEditor

[English README is here](README.en.md)

[DBML](https://dbml.dbdiagram.io/home)（Database Markup Language）のデスクトップビューア/エディタです。Tauri 製です。

![JPDBMLEditor スクリーンショット](Docs/images/JPDBMLEditor.png)

既存の VSCode 拡張には「ER 図プレビューの見た目・レイアウトが悪い」「VSCode の器が重い」という不満があったため、独立した軽量デスクトップアプリとして自作しました。テキスト編集は引き続き VSCode（任意のエディタ）で行い、本アプリは DBML を**見る・整える・軽く編集する**ことに特化しています。

## 主な機能

- **全体 ER 図表示** — `.dbml` を公式パーサ `@dbml/core` でパースし、全テーブルとリレーションを自動レイアウト（ELK.js + React Flow）で描画します。
- **検索による絞り込み** — 常設の検索フィールドでテーブル名・カラム名の両方を検索できます。カラムがヒットした場合はテーブル内の該当カラムをハイライトします。
- **近傍フォーカス** — テーブルをクリックすると、リレーションでつながるテーブルだけを表示します。ホップ数は UI で変更できます（初期値 1）。
- **インライン編集** — ER 図上でカラムの追加・編集・移動・削除、note の編集ができます。
- **最小編集で書式保持** — 全体を逆生成せず、変更箇所だけを元テキストに最小編集で反映します。コメント・並び順・整形を壊しません。
- **明示保存 + 無限 Undo/Redo** — 編集はメモリ上に保持し、保存ボタン / Cmd+S でのみファイルへ書き込みます。Cmd+Z / Cmd+Shift+Z で Undo/Redo できます。
- **手動リロード** — ファイル監視はせず、外部（VSCode 等）での変更はリロードボタンで明示的に取り込みます。未保存編集がある場合は破棄確認ダイアログを表示します。
- **レイアウトのサイドカーファイル** — テーブル位置やカラム幅などの見た目状態は `.dbml` の隣の `foo.jpdbml.json` に保存し、DBML 本体は汚しません。サイドカーが無い/壊れている場合は自動レイアウトにフォールバックします。
- **IME 対応** — すべてのテキスト入力で日本語 IME の変換確定/キャンセル（Enter/Esc）を誤発火しないようガードしています。

## インストール

[Releases ページ](https://github.com/Junpeiwada/JPDBMLEditor/releases/latest)から最新版をダウンロードし、
自分の OS 用のファイルを選んでください。

| OS | ファイル | 備考 |
| --- | --- | --- |
| macOS（Apple Silicon） | `JPDBMLEditor_x.y.z_aarch64.dmg` | M1/M2/M3… の Mac |
| macOS（Intel） | `JPDBMLEditor_x.y.z_x64.dmg` | Intel Mac |
| Windows | `JPDBMLEditor_x.y.z_x64-setup.exe` | 64bit |

インストール後、アプリは**自動アップデート**します。起動時に新バージョンを確認し、ツールバーの
「アップデートを確認」ボタンから手動チェックもできます。更新が見つかると、ダウンロードして
再起動する前に確認を求めます。

### 初回起動（未署名ビルド）

現在ビルドは未署名のため、初回起動時に OS の警告が出ます。想定内なので、一度だけ許可すれば大丈夫です。

- **macOS**: `.dmg` を開き、**JPDBMLEditor** を **アプリケーション**フォルダにドラッグします。初回起動時に
  「開発元を検証できないため開けません」と表示されますが、**「ゴミ箱に入れる」は押さないでください**。代わりに
  **アプリを右クリック（または Control + クリック）→「開く」**を選び、ダイアログで **「開く」**を押します。
  以降は通常どおり起動できます。（別の方法: システム設定 → プライバシーとセキュリティ →「このまま開く」）
- **Windows**: SmartScreen が「WindowsによってPCが保護されました」と表示することがあります。**「詳細情報」→「実行」**
  をクリックしてください。

## 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| 器 | Tauri 2 + Vite + TypeScript |
| UI | React 19 + MUI（トーストは notistack） |
| DBML パーサ | `@dbml/core` |
| ER 図描画 | React Flow（`@xyflow/react`）+ ELK.js 自動レイアウト |
| E2E テスト | Playwright（Tauri IPC モック使用） |

## はじめ方

### 前提条件

- Node.js 18 以上
- Rust ツールチェイン（Tauri 用）

### 開発

```bash
npm install

# デスクトップアプリとして起動（推奨）
npm run tauri dev

# フロントエンドのみ（Vite 開発サーバ）
npm run dev
```

### ビルド

```bash
npm run tauri build
```

### テスト

```bash
npm run test:e2e
```

## リリース

リリースは GitHub Actions（[.github/workflows/release.yml](.github/workflows/release.yml)）でビルドします。
`v` で始まるタグ（例: `v0.1.0`）を push すると、macOS（Apple Silicon + Intel）と Windows（NSIS `.exe`）を
ビルドし、成果物を **下書き（draft）** の GitHub Release に添付します。

バージョンを上げてタグを push するまでを一括で行う補助スクリプトを用意しています。VSCode の
「Run Task」→「release」、またはターミナルで次を実行してください。

```bash
npm run release
```

現在のバージョンを提示し、patch を +1 した値（例: `0.1.0` → `0.1.1`）を既定でサジェストします。Enter で確定、
手入力で上書きできます。確定すると、`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` の
バージョンを揃えてコミットし、main とタグを push します（タグ push でリリースビルドが起動します）。

その後、GitHub の Releases ページで成果物を確認し、下書きを **Publish（公開）** してください。公開前に
`latest.json` を開き、**全ターゲット**（`darwin-aarch64` / `darwin-x86_64` / `windows-x86_64`）の
`platforms` エントリが揃っているか確認してください。3 つのビルドジョブは並行実行され `latest.json` を
それぞれ書き込むため、エントリが欠けているとそのプラットフォームには更新が届きません。

> **自動アップデートには公開が必須です。** updater は `releases/latest/download/latest.json` を参照しますが、
> これは「最新の**公開済み**リリース」しか指しません（下書きは見えません）。公開して初めて更新が配信されます。

### 補足

- **コード署名**: 現状はビルドを**未署名**で配布しています（Apple Developer Program 未登録のため）。初回起動時に
  Gatekeeper / SmartScreen の警告が出るので、ユーザーが明示的に許可する必要があります。ワークフローには Apple
  署名・公証用の env ブロックをコメントアウトで用意してあります。将来登録したら、コメントを外して 6 つの `APPLE_*`
  シークレットを登録すれば有効になります。
- **アップデート署名鍵**: 自動アップデートの成果物は minisign の鍵ペアで署名しています（Apple 署名とは無関係で無料です）。
  **秘密鍵**は GitHub シークレット `TAURI_SIGNING_PRIVATE_KEY`、対になる**公開鍵**は
  `src-tauri/tauri.conf.json`（`plugins.updater.pubkey`）にコミットしてあります。この 2 つは必ず対で保ってください。
  ずれると全クライアントが署名検証エラーで更新を拒否します。
- **Intel 版 macOS** は Apple Silicon ランナー上でクロスビルドしており、実機での動作確認は行っていません。

## ディレクトリ構成

```
src/                 # フロント（Vite + TS + React）
├── parser/          # @dbml/core ラッパ・内部モデル変換
├── graph/           # 隣接グラフ・N ホップ探索
├── layout/          # ELK.js 自動レイアウト
├── view/            # React Flow ノード/エッジ・検索UI・パネル
├── edit/            # 最小編集ロジック（書式保持）
└── meta/            # .jpdbml.json サイドカー読み書き
src-tauri/           # Tauri（Rust: ファイルI/O）
scripts/             # リリース補助スクリプト
e2e/                 # Playwright E2E テスト
Docs/                # 設計ドキュメント
SampleDBML/          # 動作確認用のサンプル DBML（gitignore 済み。リポジトリには含まれません）
```

## ドキュメント

設計ドキュメントは [Docs/](Docs/) にあります。全体像は [全体設計.md](Docs/全体設計.md)、画面仕様は [UI設計.md](Docs/UI設計.md)、進め方は [実装計画.md](Docs/実装計画.md) を参照してください。

## ライセンス

[MIT](LICENSE)
