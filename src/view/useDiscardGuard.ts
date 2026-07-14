// 未保存破棄ガード(Docs/計画-保存UNDO計画.md「未保存破棄のガード」)一式をまとめるフック。
// 「別ファイルを開く」「履歴から開く」「ウィンドウを閉じる」など、未保存編集がある状態で
// 実行すると破棄が起きる操作をいったん保留し、確認ダイアログの選択後に実行する。
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProviderContext } from "notistack";

interface UseDiscardGuardParams {
  isDirty: boolean;
  saveFile: () => Promise<boolean>;
  openFile: () => Promise<boolean>;
  openPath: (path: string) => Promise<boolean>;
  removeRecent: (path: string) => void;
  enqueueSnackbar: ProviderContext["enqueueSnackbar"];
}

export interface UseDiscardGuardResult {
  /** 破棄確認ダイアログを表示中か。 */
  discardGuardOpen: boolean;
  /**
   * 未保存編集があるかを確認し、あれば実行を保留してダイアログを開く。
   * 未保存が無ければ即座に action を実行する。呼び出し側は「開く前に必ず通す」ゲートとして使う。
   */
  guardDiscard: (action: () => void | Promise<void>) => void;
  closeDiscardGuard: () => void;
  /** 「破棄して続行」: 保留していた操作をそのまま実行する。 */
  handleDiscardAndProceed: () => void;
  /** 「保存して続行」: 先に明示保存してから、保留していた操作を実行する。 */
  handleSaveAndProceed: () => Promise<void>;
  /** ファイルを開く(ツールバー/ショートカット起点)。未保存編集があれば破棄確認を挟む。 */
  handleOpenFile: () => void;
  /** 履歴からファイルを開く。同じく未保存編集があれば破棄確認を挟む。 */
  handleSelectRecentGuarded: (path: string) => void;
}

export function useDiscardGuard({
  isDirty,
  saveFile,
  openFile,
  openPath,
  removeRecent,
  enqueueSnackbar,
}: UseDiscardGuardParams): UseDiscardGuardResult {
  // isDirty の最新値を非同期処理・イベントハンドラ(ウィンドウクローズ等)のクロージャから
  // 参照するためのref。state依存のuseCallbackを都度作り直さずに済ませる。
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // 「別ファイルを開く」操作をいったん保留し、確認ダイアログの選択後に実行する。
  // pendingAction は保留中の実行内容(ダイアログからの選択で呼び分ける)。
  const [discardGuardOpen, setDiscardGuardOpen] = useState(false);
  const pendingActionRef = useRef<(() => void | Promise<void>) | null>(null);
  // 破棄確認ダイアログを表示中かどうかの最新値(ガードの排他判定に使う。state だと
  // guardDiscard のクロージャが古い値を見るため ref で持つ)。
  const discardGuardOpenRef = useRef(false);
  discardGuardOpenRef.current = discardGuardOpen;
  // 「破棄して閉じる」意思が確定したフラグ(レビュー M-2)。onCloseRequested の再発火時に
  // これが立っていれば preventDefault せず素通しさせ、ダイアログ再表示ループを防ぐ。
  const forceCloseRef = useRef(false);

  // 未保存編集があるかを確認し、あれば実行を保留してダイアログを開く。
  // 未保存が無ければ即座に action を実行する。呼び出し側は「開く前に必ず通す」ゲートとして使う。
  // すでにダイアログ表示中なら新たな要求は無視する(レビュー M-3: 保留アクションの上書き・
  // 二重表示を防ぐ。ユーザーは先に出ているダイアログを処理してから操作し直す)。
  const guardDiscard = useCallback(
    (action: () => void | Promise<void>) => {
      if (discardGuardOpenRef.current) return;
      if (isDirtyRef.current) {
        pendingActionRef.current = action;
        setDiscardGuardOpen(true);
      } else {
        void action();
      }
    },
    [],
  );

  const closeDiscardGuard = useCallback(() => {
    setDiscardGuardOpen(false);
    pendingActionRef.current = null;
  }, []);

  // 「破棄して続行」: 保留していた操作をそのまま実行する。
  const handleDiscardAndProceed = useCallback(() => {
    const action = pendingActionRef.current;
    setDiscardGuardOpen(false);
    pendingActionRef.current = null;
    if (action) void action();
  }, []);

  // 「保存して続行」: 先に明示保存してから、保留していた操作を実行する。
  // 保存に失敗した場合は操作を中断する(トーストはsaveFile内で表示済み)。
  const handleSaveAndProceed = useCallback(async () => {
    const action = pendingActionRef.current;
    setDiscardGuardOpen(false);
    pendingActionRef.current = null;
    const ok = await saveFile();
    if (ok && action) void action();
  }, [saveFile]);

  // 履歴メニューからの選択。存在しない/読めないファイルなら通知して履歴から除去する。
  const handleSelectRecent = useCallback(
    async (path: string) => {
      const ok = await openPath(path);
      if (!ok) {
        enqueueSnackbar("ファイルが見つかりませんでした。履歴から削除します。", { variant: "warning" });
        removeRecent(path);
      }
    },
    [openPath, removeRecent, enqueueSnackbar],
  );

  // ファイルを開く(ツールバー/ショートカット起点)。未保存編集があれば破棄確認を挟む。
  const handleOpenFile = useCallback(() => {
    guardDiscard(async () => {
      await openFile();
    });
  }, [guardDiscard, openFile]);

  // 履歴からファイルを開く。同じく未保存編集があれば破棄確認を挟む。
  const handleSelectRecentGuarded = useCallback(
    (path: string) => {
      guardDiscard(() => handleSelectRecent(path));
    },
    [guardDiscard, handleSelectRecent],
  );

  // ウィンドウクローズ要求(Docs/計画-保存UNDO計画.md「未保存破棄のガード」)。
  // 未保存編集があれば閉じるのを一旦止め、破棄確認ダイアログを経由させる。
  // 「破棄して続行」を選んだ場合のみ実際にウィンドウを閉じる(保存して続行も同様に閉じる)。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        // 「破棄して閉じる」確定後の再要求(自分で close() を呼んだ結果)は素通しさせる。
        // これをしないと、dirty のまま close() → 再び onCloseRequested → dirty → 再ダイアログ、の
        // 無限ループになる(レビュー M-2)。
        if (forceCloseRef.current) return;
        if (!isDirtyRef.current) return; // 未保存が無ければ標準どおり閉じさせる
        event.preventDefault();
        // クローズは guardDiscard を介さず、専用のガードを開く(action にクローズ意思の確定を仕込む)。
        // 「破棄して続行」/「保存して続行」どちらの経路でも、この action 実行時には
        // forceCloseRef を立ててから close() する。
        guardDiscard(() => {
          forceCloseRef.current = true;
          void getCurrentWindow().close();
        });
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [guardDiscard]);

  return {
    discardGuardOpen,
    guardDiscard,
    closeDiscardGuard,
    handleDiscardAndProceed,
    handleSaveAndProceed,
    handleOpenFile,
    handleSelectRecentGuarded,
  };
}
