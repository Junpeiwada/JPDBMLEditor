// 左サイドパネルのレイアウト設定(パネル幅・テーブル名カラム幅)の状態管理。
// useLodThreshold と同じ方式で localStorage に永続化する(あれば使う、無ければ既定値)。
import { useCallback, useEffect, useState } from 'react';

/** パネル全体の幅(px)。既定値は従来の固定幅と同じ。 */
export const DEFAULT_PANEL_WIDTH = 220;
export const MIN_PANEL_WIDTH = 160;
export const MAX_PANEL_WIDTH = 600;

/** テーブル一覧の「テーブル名」カラムの幅(px)。残りが「日本語名」カラムになる。 */
export const DEFAULT_NAME_COL_WIDTH = 110;
export const MIN_NAME_COL_WIDTH = 60;
export const MAX_NAME_COL_WIDTH = 480;

const PANEL_WIDTH_KEY = 'jpdbml.panelWidth';
const NAME_COL_WIDTH_KEY = 'jpdbml.panelNameColWidth';

/** localStorage から復元する(壊れていれば既定値へフォールバック)。 */
function loadInitial(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    // 範囲外の保存値はクランプして受け入れる(仕様変更で下限/上限が変わっても壊れない)。
    return Math.min(max, Math.max(min, value));
  } catch {
    return fallback;
  }
}

/**
 * localStorage 永続の幅(px)を保持する共通フック。
 * setter は範囲内へクランプして更新し、変更のたびに localStorage へ書き込む。
 */
function usePersistedWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): [number, (value: number) => void] {
  const [width, setWidth] = useState<number>(() => loadInitial(key, fallback, min, max));

  useEffect(() => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
      // プライベートモード等で書けなくてもアプリは動作継続(セッション内は有効)。
    }
  }, [key, width]);

  const update = useCallback(
    (value: number) => {
      setWidth(Math.min(max, Math.max(min, Math.round(value))));
    },
    [min, max],
  );

  return [width, update];
}

/** パネル全体の幅(px)。右端ハンドルのドラッグで調整する。 */
export function usePanelWidth(): [number, (value: number) => void] {
  return usePersistedWidth(PANEL_WIDTH_KEY, DEFAULT_PANEL_WIDTH, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);
}

/** テーブル一覧の「テーブル名」カラム幅(px)。ヘッダー行の境界ドラッグで調整する。 */
export function useNameColWidth(): [number, (value: number) => void] {
  return usePersistedWidth(
    NAME_COL_WIDTH_KEY,
    DEFAULT_NAME_COL_WIDTH,
    MIN_NAME_COL_WIDTH,
    MAX_NAME_COL_WIDTH,
  );
}
