// LOD(詳細度切り替え)閾値の状態管理。ズーム率がこの値未満のとき、テーブルノードは
// カラムを間引いて代表行(PK/FK)だけを描く(縮小=俯瞰時のDOM要素数を桁で減らす)。
// 値は localStorage に保存し、次回起動時も維持する(あれば使う、無ければ既定値)。
import { useCallback, useEffect, useState } from 'react';

/** 既定のLOD閾値。全体表示は自動fitで概ね 0.1〜0.3 に収まるため、その帯で確実に間引かれる値。 */
export const DEFAULT_LOD_THRESHOLD = 0.6;

/** スライダーの下限/上限。0.05 は minZoom と揃える(それ未満は意味を持たない)。 */
export const MIN_LOD_THRESHOLD = 0.05;
export const MAX_LOD_THRESHOLD = 1.5;

const STORAGE_KEY = 'jpdbml.lodThreshold';

/** localStorage から復元する(壊れていれば既定値へフォールバック)。 */
function loadInitial(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_LOD_THRESHOLD;
    const value = Number(raw);
    if (!Number.isFinite(value)) return DEFAULT_LOD_THRESHOLD;
    // 範囲外の保存値はクランプして受け入れる(仕様変更で下限/上限が変わっても壊れない)。
    return Math.min(MAX_LOD_THRESHOLD, Math.max(MIN_LOD_THRESHOLD, value));
  } catch {
    return DEFAULT_LOD_THRESHOLD;
  }
}

/**
 * LOD閾値を localStorage 永続で保持するフック。
 * 返り値の setter は状態更新と同時に localStorage へ書き込む。
 */
export function useLodThreshold(): [number, (value: number) => void] {
  const [threshold, setThreshold] = useState<number>(loadInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(threshold));
    } catch {
      // プライベートモード等で書けなくてもアプリは動作継続(セッション内は有効)。
    }
  }, [threshold]);

  const update = useCallback((value: number) => {
    setThreshold(Math.min(MAX_LOD_THRESHOLD, Math.max(MIN_LOD_THRESHOLD, value)));
  }, []);

  return [threshold, update];
}
