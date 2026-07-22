// 自動アップデート（デスクトップのみ）。
// - ツールバー(TopBar)の更新ボタン、およびネイティブメニュー「ヘルプ→アップデートを確認」から手動チェック
// - 起動時に一度だけ自動チェック（バックグラウンド）
//
// updater プラグインは Tauri ランタイム上でのみ動く。`npm run dev` の素のブラウザや
// Playwright(IPC モック)では @tauri-apps/plugin-updater の呼び出しが失敗するため、
// isTauri() でガードし、非 Tauri 環境では何もしない（no-op）。
import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import { useSnackbar, type SnackbarKey } from 'notistack';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

// Rust 側（lib.rs の EVENT_CHECK_UPDATE）と一致させる。ネイティブメニュークリックで飛んでくる。
const MENU_CHECK_UPDATE_EVENT = 'menu://check-update';

/** 手動チェック時のユーザーへの結果通知の粒度。 */
type CheckOptions = {
  /** true のとき「最新です」等の結果もトーストで通知する（手動チェック向け）。
      起動時の自動チェックでは false にして、更新がある場合のみ通知する。 */
  notifyWhenUpToDate: boolean;
};

/** Tauri/Rust から来る例外を人間可読なメッセージへ丸める（生の内部情報を UI に晒さない）。 */
function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useAppUpdater() {
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  // チェック〜適用（ダウンロード/再起動）までを 1 本のクリティカルセクションとして守るロック。
  // setBusy は非同期のため state ではなく ref で即時に判定する（連打・自動+手動の二重起動を防ぐ）。
  const runningRef = useRef(false);
  // UI（更新ボタンの無効化）用。ロックとは別に保持する。
  const [busy, setBusy] = useState(false);
  // 起動時自動チェックを一度だけ走らせるためのガード。
  const didAutoCheck = useRef(false);

  // クリティカルセクションのロックを解放する（冪等）。
  // チェック確定時・「後で」選択時・applyUpdate 完了時のいずれか 1 箇所から呼ばれる。
  const releaseLock = useCallback(() => {
    runningRef.current = false;
    setBusy(false);
  }, []);

  // 更新の適用（ダウンロード→インストール→再起動）。ロックは呼び出し元(runCheck)が握ったまま渡す。
  const applyUpdate = useCallback(
    async (update: Update, progressKey: SnackbarKey) => {
      try {
        await update.downloadAndInstall();
        closeSnackbar(progressKey);
        enqueueSnackbar('更新を適用しました。再起動します…', { variant: 'success' });
        // 成功時は relaunch でプロセスごと再起動するため update.close() は不要
        // （プロセス終了でネイティブ側リソースも解放される）。relaunch が例外を投げた
        // 場合のみ catch で close する。
        await relaunch();
      } catch (e) {
        console.error('update apply failed:', e);
        closeSnackbar(progressKey);
        enqueueSnackbar(`更新の適用に失敗しました: ${toMessage(e)}`, { variant: 'error' });
        // 適用に失敗した Update はもう使わないのでネイティブ側リソースを解放する。
        await update.close().catch(() => {});
      } finally {
        releaseLock();
      }
    },
    [closeSnackbar, enqueueSnackbar, releaseLock],
  );

  const runCheck = useCallback(
    async ({ notifyWhenUpToDate }: CheckOptions) => {
      // 非 Tauri 環境（ブラウザ/テスト）では updater を呼ばない。
      if (!isTauri()) {
        if (notifyWhenUpToDate) {
          enqueueSnackbar('この環境では更新チェックは利用できません', { variant: 'info' });
        }
        return;
      }
      // ref で即時ロック（stale な busy を見て二重起動するのを防ぐ）。
      if (runningRef.current) return;
      runningRef.current = true;
      setBusy(true);

      // 「更新あり」トーストを出してユーザー操作（今すぐ更新/後で）待ちに入ったら true。
      // このときだけ finally での解放を見送り、解放責務を onUpdate(→applyUpdate) /
      // onLater のどちらかへ引き渡す（下のトーストの action 参照）。
      // それ以外（更新なし・エラー・非 Tauri）は finally の releaseLock で必ず解放する。
      let awaitingUserChoice = false;

      try {
        const update = await check();
        if (!update) {
          if (notifyWhenUpToDate) {
            enqueueSnackbar('最新版を使用しています', { variant: 'info' });
          }
          return;
        }
        // 更新あり。ユーザー確認を挟んでから適用する（勝手に再起動しない）。
        awaitingUserChoice = true;
        enqueueSnackbar(`新しいバージョン ${update.version} があります`, {
          variant: 'info',
          persist: true,
          preventDuplicate: true,
          action: (key) => {
            // closeSnackbar は非同期なので、確定するまでボタンが 2 回押される窓がある。
            // どちらか一方・一度きりに絞る（update.close() の二重呼び出し等を防ぐ）。
            let acted = false;
            return (
              <UpdateActions
                onUpdate={() => {
                  if (acted) return;
                  acted = true;
                  closeSnackbar(key);
                  const progressKey = enqueueSnackbar('更新をダウンロード中…', {
                    variant: 'info',
                    persist: true,
                  });
                  // ロックは applyUpdate の finally(releaseLock) が解放する。ここでは触らない。
                  void applyUpdate(update, progressKey);
                }}
                onLater={() => {
                  if (acted) return;
                  acted = true;
                  closeSnackbar(key);
                  // 使わない Update はネイティブ側リソースを解放し、ロックも確実に手放す。
                  void update.close().catch(() => {});
                  releaseLock();
                }}
              />
            );
          },
        });
      } catch (e) {
        // 起動時の自動チェックはネットワーク不通などで失敗しても静かに無視する（開発時のため log は残す）。
        console.warn('updater check failed:', e);
        if (notifyWhenUpToDate) {
          enqueueSnackbar(`更新チェックに失敗しました: ${toMessage(e)}`, { variant: 'error' });
        }
      } finally {
        // ユーザー操作待ちに入った場合のみ解放を見送る（onUpdate/onLater が解放する）。
        if (!awaitingUserChoice) releaseLock();
      }
    },
    [applyUpdate, closeSnackbar, enqueueSnackbar, releaseLock],
  );

  // ツールバーのボタン / ネイティブメニューから呼ぶ手動チェック。結果は常に通知する。
  const checkForUpdatesManually = useCallback(() => {
    void runCheck({ notifyWhenUpToDate: true });
  }, [runCheck]);

  // 起動時に一度だけ自動チェック（更新がある場合のみ通知）。
  // runCheck の参照が変わって effect が再実行されても、didAutoCheck ガードにより本体は
  // 二度と走らない（冪等）。runCheck の依存(notistack のハンドラ等)は安定前提だが、
  // 仮に不安定でもこのガードで二重チェックは起きない。
  useEffect(() => {
    if (didAutoCheck.current) return;
    didAutoCheck.current = true;
    void runCheck({ notifyWhenUpToDate: false });
  }, [runCheck]);

  // ネイティブメニュー「ヘルプ→アップデートを確認」クリックを受けて手動チェックを走らせる。
  // 非 Tauri 環境（ブラウザ/テスト）では listen しない。
  // 注: listen 登録は非同期のため、登録完了より前にメニューを押すとその 1 回は取りこぼす
  // （emit はキューされない）。実害は小さく、再クリックで復帰する。
  useEffect(() => {
    if (!isTauri()) return;
    const unlistenPromise = listen(MENU_CHECK_UPDATE_EVENT, () => {
      checkForUpdatesManually();
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [checkForUpdatesManually]);

  return { checkForUpdatesManually, isCheckingUpdate: busy };
}

// トースト内の「今すぐ更新 / 後で」ボタン。notistack の action に差し込む。
function UpdateActions({ onUpdate, onLater }: { onUpdate: () => void; onLater: () => void }) {
  return (
    <>
      <Button onClick={onUpdate} size="small" variant="outlined" color="inherit" sx={{ mr: 1 }}>
        今すぐ更新
      </Button>
      <Button onClick={onLater} size="small" color="inherit">
        後で
      </Button>
    </>
  );
}
