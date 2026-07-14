// カラム列幅(名前/型/note)編集の状態管理。手動リサイズ/オートフィット確定時の
// override マップ更新・箱幅再概算・押し出し(resolveOverlapToRight)・App への通知をまとめる。
// ErCanvas.tsx から呼ばれる(layoutNodes 系の状態は ErCanvas 側が所有し、ref/setter を渡す)。
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { DbmlModel } from '../parser/model';
import { estimateTableNodeSize } from '../layout';
import { resolveOverlapToRight, type Rect } from '../layout/resolveOverlap';
import { MIN_TABLE_WIDTH, computeColumnWidths } from '../layout/nodeSize';
import type { TableColumnWidthOverride } from '../meta/sidecar';
import { markEvent } from '../perf/perf';
import type { TableNodeType } from './TableNode';

/** リサイズ/オートフィット対象の列種別。 */
export type ColumnWidthField = 'name' | 'type' | 'note';

/** ノード配列から Record<テーブルID, {x,y}> の座標マップを作る(サイドカー通知用の共通形)。 */
export function toPositionsMap(nodes: TableNodeType[]): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) positions[n.id] = { x: n.position.x, y: n.position.y };
  return positions;
}

export interface UseColumnWidthStateParams {
  model: DbmlModel | null;
  /** サイドカー由来の保存済み列幅(ファイルを開いた時の初期値としてのみ使う)。 */
  savedColumnWidths?: Record<string, TableColumnWidthOverride>;
  /**
   * layoutNodes の最新コミット値への ref(ErCanvas 側で layoutNodes と同期して保持している ref を
   * そのまま渡す)。確定処理はここから直前フレームの座標/サイズを読み、更新後の値も書き戻す。
   */
  layoutNodesRef: { current: TableNodeType[] };
  setLayoutNodes: Dispatch<SetStateAction<TableNodeType[]>>;
  onColumnWidthsChange?: (columnWidths: Record<string, TableColumnWidthOverride>) => void;
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
}

export interface UseColumnWidthStateResult {
  /** 列幅 override マップ(single source of truth)。ノードの data 生成に使う。 */
  columnWidths: Record<string, TableColumnWidthOverride>;
  /**
   * columnWidths の最新値への ref(レイアウト useEffect の依存に入れず確定時に最新を読むため。
   * ErCanvas 側のレイアウト計算で使う)。
   */
  columnWidthsRef: { current: Record<string, TableColumnWidthOverride> };
  /** カラム列幅(名前/型/note)の手動リサイズ確定(TableNode の列境界ハンドルを離したとき)。 */
  handleColumnWidthResize: (tableId: string, field: ColumnWidthField, newWidth: number) => void;
  /** 列境界ダブルクリックでのオートフィット確定。 */
  handleColumnAutoFit: (tableId: string, field: ColumnWidthField, measuredWidth: number) => void;
}

/**
 * カラム列幅(名前/型/note)編集の状態と確定処理をまとめたフック。
 * 列幅 override は ErCanvas 内のローカル state を single source of truth にする。
 * 理由: 列幅の確定は App の ref 更新+debounce保存だけで App の state(prop savedColumnWidths)を
 * 更新しないため、prop をそのまま見ると確定後に古い override へ戻ってしまう。
 * そこで prop は「ファイルを開いた時の初期値」としてだけ使い、以降はこのローカル state で回す。
 */
export function useColumnWidthState({
  model,
  savedColumnWidths,
  layoutNodesRef,
  setLayoutNodes,
  onColumnWidthsChange,
  onPositionsChange,
}: UseColumnWidthStateParams): UseColumnWidthStateResult {
  const [columnWidths, setColumnWidths] = useState<Record<string, TableColumnWidthOverride>>(
    savedColumnWidths ?? {},
  );
  // ファイルを開き直す等で prop(初期値)が変わったらローカル state を作り直す。
  // prop はファイルオープン時にのみ変化する(App の ref 更新では変わらない)ため、
  // この同期がユーザーの確定を巻き戻すことはない。
  useEffect(() => {
    setColumnWidths(savedColumnWidths ?? {});
  }, [savedColumnWidths]);
  // レイアウト useEffect の依存に入れず確定時に最新を読むための ref(ローカル state と常に同期)。
  const columnWidthsRef = useRef(columnWidths);
  columnWidthsRef.current = columnWidths;

  // 列幅 override マップの変更を反映する共通処理(リサイズ確定/オートフィットで共用)。
  //   1. ref とローカル state に nextColumnWidths を反映(グリッド表示へ即時反映)。
  //   2. 対象ノードの箱幅を新しい列幅合計で再概算する(縮む方向も常時追従)。
  //   3. 広がった分、右側で重なる相手を押し出す(resolveOverlapToRight)。
  //   4. 列幅/座標の2マップを App へ通知(サイドカー保存)。
  const applyColumnWidths = useCallback(
    (tableId: string, nextColumnWidths: Record<string, TableColumnWidthOverride>) => {
      const prev = layoutNodesRef.current;
      if (prev.length === 0) return;
      const table = model?.tables.find((t) => t.id === tableId);
      if (!table) return;

      // 1. ref を即同期(直後の連続操作=handleColumnWidthResize が最新を読めるように)し、
      //    ローカル state も更新して nodeDataById(=グリッド表示)へ確定値を反映する。
      columnWidthsRef.current = nextColumnWidths;
      setColumnWidths(nextColumnWidths);

      // 2. 対象ノードの必要幅を新しい列幅で概算する。箱幅は列幅合計に常時追従させる
      //    (縮む方向も含む=補正2)。ユーザーが箱を直接リサイズすることはないため、
      //    「据え置き」の下駄を履かせる必要が無い(列を戻せば箱も戻る=受け入れ条件)。
      const newNodeWidth = estimateTableNodeSize(table, nextColumnWidths[tableId]).width;

      // 3. 押し出し用の矩形を組む(対象ノードだけ newNodeWidth)。
      const autoSizeById = new Map(
        (model?.tables ?? []).map((t) => [t.id, estimateTableNodeSize(t, nextColumnWidths[t.id])]),
      );
      const rects: Rect[] = prev.map((n) => {
        const w =
          n.id === tableId
            ? newNodeWidth
            : (typeof n.style?.width === 'number' ? n.style.width : undefined) ??
              n.measured?.width ??
              MIN_TABLE_WIDTH;
        const h = n.measured?.height ?? autoSizeById.get(n.id)?.height ?? 100;
        return { id: n.id, x: n.position.x, y: n.position.y, w, h };
      });
      const moved = resolveOverlapToRight(rects, tableId);

      const next = prev.map((n) => {
        const movedPos = moved[n.id];
        if (n.id === tableId) {
          return {
            ...n,
            style: { ...n.style, width: newNodeWidth },
            position: movedPos ? { x: movedPos.x, y: movedPos.y } : n.position,
          };
        }
        if (movedPos) return { ...n, position: { x: movedPos.x, y: movedPos.y } };
        return n;
      });

      // 箱幅(tableWidths)はもう保存しない(列一本化に伴い、箱は列合計から算出されるため
      // 常にサイドカーの手動幅と一致し、書き込む意味が無い=補正2/計画§4)。
      const positions = toPositionsMap(next);

      layoutNodesRef.current = next;
      setLayoutNodes(next);

      onColumnWidthsChange?.(nextColumnWidths);
      onPositionsChange?.(positions);
    },
    [model, layoutNodesRef, setLayoutNodes, onColumnWidthsChange, onPositionsChange],
  );

  // 対象テーブルの1列の override を newWidth に設定した新しい列幅マップを返す。
  // 自動概算値と一致する場合はその列の override を外す(=自動に委ねる。表示/保存の乖離防止)。
  // note 列が存在しないテーブルで field==='note' の場合は null(呼び出し側で無視)。
  const buildNextColumnWidths = useCallback(
    (
      table: DbmlModel['tables'][number],
      field: ColumnWidthField,
      newWidth: number,
    ): Record<string, TableColumnWidthOverride> | null => {
      const savedCW = columnWidthsRef.current ?? {};
      const autoCols = computeColumnWidths(table); // override 無しの自動値
      if (field === 'note' && autoCols.note === 0) return null; // note 列が無いテーブル
      const prevOverride = savedCW[table.id] ?? {};
      const nextOverride: TableColumnWidthOverride = { ...prevOverride };
      const autoForField = autoCols[field];
      // 自動概算とほぼ一致(±2px、実測誤差を許容)なら override から外す(=自動に委ねる)。
      // Math.round同士の厳密一致だと、Range実測の±1px程度のブレで一致しないことがあるため。
      if (Math.abs(newWidth - autoForField) <= 2) {
        delete nextOverride[field];
      } else {
        nextOverride[field] = newWidth;
      }
      const nextColumnWidths: Record<string, TableColumnWidthOverride> = { ...savedCW };
      if (
        nextOverride.name === undefined &&
        nextOverride.type === undefined &&
        nextOverride.note === undefined
      ) {
        delete nextColumnWidths[table.id];
      } else {
        nextColumnWidths[table.id] = nextOverride;
      }
      return nextColumnWidths;
    },
    [],
  );

  // カラム列幅(名前/型/note)の手動リサイズ確定(TableNode の列境界ハンドルを離したとき)。
  const handleColumnWidthResize = useCallback(
    (tableId: string, field: ColumnWidthField, newWidth: number) => {
      markEvent('resize:col', `${tableId}:${field}`);
      const table = model?.tables.find((t) => t.id === tableId);
      if (!table) return;
      const nextColumnWidths = buildNextColumnWidths(table, field, newWidth);
      if (nextColumnWidths) applyColumnWidths(tableId, nextColumnWidths);
    },
    [model, buildNextColumnWidths, applyColumnWidths],
  );

  // 列境界ダブルクリックでのオートフィット。TableNode 側で Range 実測した measuredWidth を
  // その列の override として適用する(自動概算とほぼ一致する場合は buildNextColumnWidths が
  // override を落とす=補正1: scrollWidthではなく実測ベースにすることで「縮める」フィットも可能)。
  const handleColumnAutoFit = useCallback(
    (tableId: string, field: ColumnWidthField, measuredWidth: number) => {
      markEvent('autofit:col', `${tableId}:${field}`);
      const table = model?.tables.find((t) => t.id === tableId);
      if (!table) return;
      const nextColumnWidths = buildNextColumnWidths(table, field, measuredWidth);
      if (nextColumnWidths) applyColumnWidths(tableId, nextColumnWidths);
    },
    [model, buildNextColumnWidths, applyColumnWidths],
  );

  return { columnWidths, columnWidthsRef, handleColumnWidthResize, handleColumnAutoFit };
}
