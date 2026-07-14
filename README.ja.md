# JPDBMLEditor

[English README is here](README.md)

[DBML](https://dbml.dbdiagram.io/home)（Database Markup Language）のデスクトップビューア/エディタ。Tauri 製。

![JPDBMLEditor スクリーンショット](Docs/images/JPDBMLEditor.png)

既存の VSCode 拡張は「ER 図プレビューの見た目・レイアウトが悪い」「VSCode の器が重い」という不満があるため、独立した軽量デスクトップアプリとして自作したもの。テキスト編集は引き続き VSCode（任意のエディタ）で行い、本アプリは DBML を**見る・整える・軽く編集する**ことに特化する。

## 主な機能

- **全体 ER 図表示** — `.dbml` を公式パーサ `@dbml/core` でパースし、全テーブルとリレーションを自動レイアウト（ELK.js + React Flow）で描画。
- **検索による絞り込み** — 常設の検索フィールドでテーブル名・カラム名の両方を検索。カラムがヒットした場合はテーブル内の該当カラムをハイライト。
- **近傍フォーカス** — テーブルをクリックすると、リレーションでつながるテーブルだけを表示。ホップ数は UI で可変（初期値 1）。
- **インライン編集** — ER 図上でカラムの追加・編集・移動・削除、note の編集が可能。
- **最小編集で書式保持** — 全体を逆生成せず、変更箇所だけを元テキストに最小編集で反映。コメント・並び順・整形を壊さない。
- **明示保存 + 無限 Undo/Redo** — 編集はメモリ上に保持し、保存ボタン / Cmd+S でのみファイルへ書き込む。Cmd+Z / Cmd+Shift+Z で Undo/Redo。
- **手動リロード** — ファイル監視はせず、外部（VSCode 等）での変更はリロードボタンで明示的に取り込む。未保存編集がある場合は破棄確認ダイアログを表示。
- **レイアウトのサイドカーファイル** — テーブル位置やカラム幅などの見た目状態は `.dbml` の隣の `foo.jpdbml.json` に保存し、DBML 本体は汚さない。サイドカーが無い/壊れている場合は自動レイアウトにフォールバック。
- **IME 対応** — すべてのテキスト入力で日本語 IME の変換確定/キャンセル（Enter/Esc）を誤発火しないようガード。

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
e2e/                 # Playwright E2E テスト
Docs/                # 設計ドキュメント
SampleDBML/          # 動作確認用のサンプル DBML（gitignore 済み。リポジトリには含まれない）
```

## ドキュメント

設計ドキュメントは [Docs/](Docs/) にある。全体像は [全体設計.md](Docs/全体設計.md)、画面仕様は [UI設計.md](Docs/UI設計.md)、進め方は [実装計画.md](Docs/実装計画.md) を参照。

## ライセンス

[MIT](LICENSE)
