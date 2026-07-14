import type { Page } from '@playwright/test';

// Tauri IPC(window.__TAURI_INTERNALS__.invoke)をブラウザに注入するモック。
// フロントの @tauri-apps/plugin-* は最終的にすべて invoke(cmd, args) を通るため、
// ここを差し替えるだけで fs(read/write/exists/watch)・dialog(open) を丸ごとモックできる。
//
// 保存(write_text_file)は本文バイト列 + ヘッダのパスという実プラグイン固有の渡し方をするため、
// モック側でデコードして仮想FSへ反映している。テストは window.__mockState.files[パス] で
// 「実際に書き出されたテキスト」をそのまま観測できる。
//
// テストは初期化オプションで:
//  - files: 仮想ファイルシステム(パス→内容)。read_text_file/exists が参照する。
//  - dialogPath: dialog|open が返すパス(ダイアログで選択されるファイル)。null でキャンセル扱い。
// を渡す。ページ側からは window.__mockState を通じて実行後の状態(書き込み・呼び出し履歴)を観測できる。

export interface TauriMockInit {
  /** 仮想FS。キー=フルパス, 値=テキスト内容。存在しないパスは read でエラー・exists で false。 */
  files?: Record<string, string>;
  /** dialog|open が返すパス。省略/null なら「キャンセル」(null を返す)。 */
  dialogPath?: string | null;
}

export interface MockState {
  files: Record<string, string>;
  /** invoke されたコマンドの記録(cmd と主要引数)。テストの観測に使う。 */
  calls: Array<{ cmd: string; path?: string }>;
}

declare global {
  interface Window {
    __mockState: MockState;
  }
}

/**
 * ページ生成前に Tauri IPC モックを注入する。必ず page.goto の前に呼ぶこと
 * (addInitScript は以降のナビゲーションすべてに適用される)。
 */
export async function installTauriMock(page: Page, init: TauriMockInit = {}): Promise<void> {
  await page.addInitScript((initArg: TauriMockInit) => {
    const files: Record<string, string> = { ...(initArg.files ?? {}) };
    const dialogPath = initArg.dialogPath ?? null;
    const state: MockState = { files, calls: [] };
    window.__mockState = state;

    const internals = (window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ ?? {});

    // getCurrentWindow()(@tauri-apps/api/window)は metadata.currentWindow.label を読む。
    // これが無いと App の初期化(閉じる要求のフック登録)で例外になり、画面が真っ白になる。
    internals.metadata = {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    };

    // watch のイベントコールバックは transformCallback でIDに変換され、runCallback で呼ばれる。
    // テストでは実ファイル変更を起こさないため、コールバックは登録するが発火はしない。
    const callbacks = new Map<number, (payload: unknown) => void>();
    let callbackId = 0;
    internals.transformCallback = (cb: (payload: unknown) => void, _once?: boolean) => {
      const id = ++callbackId;
      callbacks.set(id, cb);
      return id;
    };
    internals.unregisterCallback = (id: number) => callbacks.delete(id);
    internals.runCallback = (id: number, payload: unknown) => callbacks.get(id)?.(payload);
    internals.callbacks = callbacks;
    internals.convertFileSrc = (p: string) => p;

    // 本文バイト列を Uint8Array に正規化する(Uint8Array / ArrayBuffer / 数値キーの素オブジェクト)。
    function toBytes(value: unknown): Uint8Array | null {
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (value == null || typeof value !== 'object') return null;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0 || !keys.every((k) => /^\d+$/.test(k))) return null;
      const out = new Uint8Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        const v = obj[String(i)];
        if (typeof v !== 'number') return null;
        out[i] = v;
      }
      return out;
    }

    // invoke の第3引数 { headers: { path } } からパスを取り出す(値はURLエンコード済み)。
    function pathFromOptions(options: unknown): string | undefined {
      const headers = (options as { headers?: Record<string, unknown> } | undefined)?.headers;
      const raw = headers?.path;
      if (typeof raw !== 'string') return undefined;
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }

    internals.invoke = async (cmd: string, args: Record<string, unknown> = {}, options?: unknown) => {
      const path = typeof args.path === 'string' ? (args.path as string) : undefined;
      state.calls.push({ cmd, path });

      switch (cmd) {
        case 'plugin:dialog|open':
          // multiple:false 想定。選択パス or キャンセル(null)。
          return dialogPath;

        case 'plugin:fs|read_text_file': {
          if (path == null || !(path in files)) {
            throw new Error(`ENOENT: no such file: ${path}`);
          }
          // 実プラグインは数値配列(バイト列)を受け取り TextDecoder で復号する。
          return Array.from(new TextEncoder().encode(files[path]));
        }

        case 'plugin:fs|write_text_file': {
          // 実プラグインの write は他コマンドと引数の渡し方が違う(実測):
          //   args    = 本文そのもののバイト列(Uint8Array)。args.path は存在しない。
          //   options = { headers: { path: '<URLエンコードされたパス>' } }
          // そのため path は第3引数のヘッダから取り出し、本文はバイト列をデコードする。
          const writePath = pathFromOptions(options) ?? path;
          const bytes = toBytes(args);
          if (writePath != null && bytes) {
            files[writePath] = new TextDecoder().decode(bytes);
            // 呼び出し履歴にもパスを残す(他コマンドと同じ観測方法にするため)。
            state.calls[state.calls.length - 1].path = writePath;
          }
          return null;
        }

        case 'plugin:fs|exists':
          return path != null && path in files;

        case 'plugin:fs|watch':
          // rid(リソースID)を返す。以降 unwatch されるまで有効。イベントは発火しない。
          return 1;

        case 'plugin:fs|unwatch':
          return null;

        default:
          // 未対応コマンドは null(サイドカー読み込み等の周辺は無害に流す)。
          return null;
      }
    };
  }, init);
}
