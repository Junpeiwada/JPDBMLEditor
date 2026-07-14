// ER図レイアウトの純粋変換ロジック。ELKの座標計算結果(posById)とモデルから
// React Flow のノード/エッジ配列を組み立てる部分を、レイアウト用 useEffect(ErCanvas.tsx)から
// 分離する。ELK呼び出し自体と ref(savedPositionsRef/savedColumnWidthsRef 等)の読み取りは
// 従来どおり effect 側で行い、読み取った値をここへ引数として渡す(読み取りタイミングを変えない)。
import type { Edge } from '@xyflow/react';
import type { DbmlModel, DbmlRefEndpoint } from '../parser/model';
import type { LayoutNodeOutput } from '../layout/types';
import { estimateTableNodeSize } from '../layout';
import type { TableColumnWidthOverride } from '../meta/sidecar';
import type { TableNodeType } from './TableNode';
import type { RefEdgeData } from './RefEdge';

/**
 * リレーションendpointに対応するカラム行のハンドルID(=カラムID)を解決する。
 * endpoint のカラム(複合キーは先頭カラム代表)がテーブル上に実在し、TableNode 側で
 * ハンドルが描画される(isForeignKey)場合のみカラム行ハンドルを使う。
 * 見つからなければ null(呼び出し側はテーブル既定ハンドルへフォールバックする)。
 */
export function resolveColumnId(
  tablesById: Map<string, DbmlModel['tables'][number]>,
  ep: DbmlRefEndpoint,
): string | null {
  const table = tablesById.get(ep.tableId);
  const name = ep.columnNames[0];
  if (!table || !name) return null;
  const col = table.columns.find((c) => c.name === name);
  return col && col.isForeignKey ? col.id : null;
}

/**
 * ELKの座標計算結果(posById)とテーブル本体から React Flow のノード配列を組み立てる。
 * ここでは座標とテーブル本体のみを確定する。検索ハイライト・フォーカス起点・濃淡(dimmed)・
 * 編集中データは ErCanvas 側の useMemo で都度マージする(モード変更のたびにこの
 * レイアウト計算をやり直さないための分離)。
 * savedPositions(サイドカー由来の保存済み座標)があれば ELK 結果より優先して採用する
 * (設計原則3: あれば使う補助情報)。
 */
export function buildLayoutNodes(
  allTables: DbmlModel['tables'],
  posById: Map<string, LayoutNodeOutput>,
  savedColumnWidths: Record<string, TableColumnWidthOverride> | undefined,
  savedPositions: Record<string, { x: number; y: number }> | undefined,
): TableNodeType[] {
  return allTables.map((table) => {
    const pos = posById.get(table.id);
    // ノードサイズ概算は保存済み列幅(override)を反映する。列を広げたらノードも広がる。
    const size = estimateTableNodeSize(table, savedColumnWidths?.[table.id]);
    // サイドカーに保存済みの座標があればそれを最優先(ユーザーが動かした配置の復元)。
    // 無ければ ELK の自動レイアウト結果を使う(設計原則3: あれば使う補助情報)。
    const savedPos = savedPositions?.[table.id];
    return {
      id: table.id,
      type: 'table',
      position: savedPos ?? { x: pos?.x ?? 0, y: pos?.y ?? 0 },
      // ウィンドウのタイトルバー移動と同じ発想: テーブル名の青いヘッダーを掴んだときだけ
      // ノード移動、それ以外(カラム行・余白)を掴んだらパン(スクロール)に回す。
      // dragHandle に一致する要素起点のドラッグのみがノード移動として扱われる。
      dragHandle: '.table-drag-handle',
      data: {
        table,
        matchedColumnIds: new Set<string>(),
        isFocusOrigin: false,
      },
      // width のみ style で固定する(列幅の基準)。height は固定しない:
      // ノードは overflow:hidden かつ全カラム表示+インライン編集行で伸縮するため、
      // 固定するとカラム増減時に下が切れる。onlyRenderVisibleElements の可視判定は
      // React Flow が初回描画後に実測する measured サイズで行われるので height 明示は不要
      // (初回1フレームのみ全描画、以降のパン/ズーム中は判定が効く)。
      //
      // 箱の幅はユーザーが直接リサイズしない。常に列幅合計(estimateTableNodeSize、
      // 保存済み列幅overrideを反映済み)に一致させる(列単位リサイズへの一本化=決定事項)。
      style: { width: size.width },
    };
  });
}

/**
 * モデルの全リレーションから React Flow のエッジ配列を組み立てる。表示/非表示ではなく
 * 濃淡で出し分けるため、全リレーションを対象にする。左右どちらの辺から線を出すかは
 * 固定せず、RefEdge 側が両ノードの実位置から毎描画で最近傍の辺(handle)を選ぶ(floating edge)。
 * ここではカラムIDだけを解決して渡す。
 */
export function buildLayoutEdges(
  refs: DbmlModel['refs'],
  tablesById: Map<string, DbmlModel['tables'][number]>,
): Edge<RefEdgeData>[] {
  return refs.map((ref) => {
    const [src, tgt] = ref.endpoints;
    const srcColId = resolveColumnId(tablesById, src);
    const tgtColId = resolveColumnId(tablesById, tgt);
    return {
      id: ref.id,
      source: src.tableId,
      target: tgt.tableId,
      type: 'ref',
      data: {
        multiplicity: ref.multiplicity,
        sourceColumnId: srcColId ?? undefined,
        targetColumnId: tgtColId ?? undefined,
      },
    };
  });
}
