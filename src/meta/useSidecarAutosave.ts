// 見た目状態(配置座標 + 列幅)のサイドカー保存。ドラッグ/リサイズ完了のたびに
// 呼ばれるため、連続操作をまとめて1回だけ書き込むよう debounce する(.dbml 本体は一切変更しない)。
//
// サイドカーは全上書きなので、一部だけを別々に書くと残りが消える。そこで
// 「座標」「列幅」の最新マップを別々の ref に保持し、どのハンドラが呼ばれても
// 最新値を saveSidecarState にまとめて渡す。ErCanvas は各コールバックで
// 「全テーブルの完全なマップ」を送ってくる前提(部分マップではない)。
//
// テーブル幅(tableWidths)はもう ErCanvas から通知されない(列一本化により箱は常に
// 列幅合計から算出されるため=補正2)。サイドカーへは後方互換のため空マップを書く
// (readSidecar 側は引き続き旧ファイルの tableWidths を読めるが、新規書き込みは行わない)。
import { useCallback, useEffect, useRef } from "react";
import type { TableColumnWidthOverride, TablePosition } from "./sidecar";

interface UseSidecarAutosaveParams {
  savedColumnWidths: Record<string, TableColumnWidthOverride>;
  saveSidecarState: (
    positions: Record<string, TablePosition>,
    columnWidths: Record<string, TableColumnWidthOverride>,
  ) => Promise<void>;
}

export interface UseSidecarAutosaveResult {
  handlePositionsChange: (positions: Record<string, TablePosition>) => void;
  handleColumnWidthsChange: (columnWidths: Record<string, TableColumnWidthOverride>) => void;
}

export function useSidecarAutosave({
  savedColumnWidths,
  saveSidecarState,
}: UseSidecarAutosaveParams): UseSidecarAutosaveResult {
  const sidecarSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPositionsRef = useRef<Record<string, { x: number; y: number }> | null>(null);
  const latestColumnWidthsRef = useRef<Record<string, TableColumnWidthOverride>>(savedColumnWidths);
  const SIDECAR_SAVE_DEBOUNCE_MS = 500;

  // ファイルを開き直したら列幅refをそのファイルの保存値へ更新する(前のファイルの値を持ち越さない)。
  useEffect(() => {
    latestColumnWidthsRef.current = savedColumnWidths;
  }, [savedColumnWidths]);

  const scheduleSidecarSave = useCallback(() => {
    if (sidecarSaveTimerRef.current) clearTimeout(sidecarSaveTimerRef.current);
    sidecarSaveTimerRef.current = setTimeout(() => {
      sidecarSaveTimerRef.current = null;
      const positions = latestPositionsRef.current;
      // 座標を一度も動かしていない場合は positions が null。その場合は空マップで書く
      // (列幅だけ変えたケース。座標は自動レイアウトに委ねる=空でよい)。
      if (
        positions === null &&
        Object.keys(latestColumnWidthsRef.current).length === 0
      ) {
        return;
      }
      // tableWidths は saveSidecarState 内部で常に空マップを書く(箱リサイズ廃止=補正2)。
      void saveSidecarState(positions ?? {}, latestColumnWidthsRef.current);
    }, SIDECAR_SAVE_DEBOUNCE_MS);
  }, [saveSidecarState]);

  const handlePositionsChange = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      latestPositionsRef.current = positions;
      scheduleSidecarSave();
    },
    [scheduleSidecarSave],
  );

  const handleColumnWidthsChange = useCallback(
    (columnWidths: Record<string, TableColumnWidthOverride>) => {
      latestColumnWidthsRef.current = columnWidths;
      scheduleSidecarSave();
    },
    [scheduleSidecarSave],
  );

  // アンマウント時に保留中の保存を取りこぼさない(タイマーが残っていたら即実行)。
  useEffect(() => {
    return () => {
      if (sidecarSaveTimerRef.current) {
        clearTimeout(sidecarSaveTimerRef.current);
        const positions = latestPositionsRef.current;
        if (
          positions !== null ||
          Object.keys(latestColumnWidthsRef.current).length > 0
        ) {
          void saveSidecarState(positions ?? {}, latestColumnWidthsRef.current);
        }
      }
    };
  }, [saveSidecarState]);

  return { handlePositionsChange, handleColumnWidthsChange };
}
