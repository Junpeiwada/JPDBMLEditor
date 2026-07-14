// ER図キャンバス。React Flow で全体ER図/絞り込み結果/フォーカス近傍を描画する。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  useReactFlow,
  applyNodeChanges,
  type Edge,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Box, Typography, Chip } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { DbmlModel } from '../parser/model';
import { computeTableLayout } from '../layout';
import { MOVE_GUTTER_WIDTH } from '../layout/nodeSize';
import type { TableColumnWidthOverride } from '../meta/sidecar';
import { buildAdjacencyGraphFromModel, findTablesWithinHops } from '../graph/adjacency';
import { TableNode, type TableNodeType, type TableNodeData, type PendingInsert, type PendingEdit } from './TableNode';
import { RefEdge, type RefEdgeData } from './RefEdge';
import { filterModel, type TableMatch } from './filter';
import { perfSpan, markEvent } from '../perf/perf';
import type { ViewMode } from './viewMode';
import type { InsertPosition } from '../edit/insertColumn';
import type { MoveDirection } from '../edit/moveColumn';
import type { ColumnInput } from '../edit/lineFormat';
import type { EditRowFocusField } from './ColumnEditRow';
import type { DbmlColumn } from '../parser/model';
import { useModeColors } from '../theme/ModeColorsContext';
import { useLodState } from './useLodState';
import { useColumnWidthState, toPositionsMap } from './useColumnWidthState';
import { buildLayoutNodes, buildLayoutEdges } from './erCanvasLayout';

// LOD(詳細度切り替え)の閾値は props(lodThreshold)で受け取り、左パネルから調整可能にする。
// ズーム率がこれ未満のとき、テーブルノードはカラムを全部描かず代表行(PK/FK)だけに間引く
// (全体俯瞰=縮小時のDOM要素数を桁で減らす)。既定値/範囲は useLodThreshold を参照。

const nodeTypes = { table: TableNode };
const edgeTypes = { ref: RefEdge };

/** App側で保持する挿入セッションの状態(TableNode/ColumnEditRowへ渡す形に変換する)。 */
export interface PendingInsertState {
  tableId: string;
  tableName: string;
  anchorColumnId: string | null;
  anchorColumnName: string | null;
  position: InsertPosition;
}

/** App側で保持する既存カラム編集セッションの状態。columnName は編集開始時点の名前(再特定用)。 */
export interface PendingEditState {
  tableId: string;
  tableName: string;
  columnId: string;
  columnName: string;
  focusField: EditRowFocusField;
}

/**
 * カメラ(視点)移動コマンド(Docs/設計-視点移動.md)。
 * 「視点を動かすべき操作」だけがこれを発行し、ErCanvas は seq の変化にのみ反応して fitView する
 * (viewMode やノード集合の変化からは絶対に fitView を導出しない)。
 * - fit-all: 全体にフィット(F1/P3/B1/B2)。
 * - fit-tables: 指定テーブル群にフィット(P1/P2)。実行時点の viewMode(focus)の近傍集合を使うため、
 *   発行側はテーブルID集合を渡す必要はない(発行時点ではレイアウト未確定のこともあるため)。
 */
export interface CameraCommand {
  seq: number;
  type: 'fit-all' | 'fit-tables';
}

interface ErCanvasProps {
  model: DbmlModel | null;
  viewMode: ViewMode;
  /** debounce 済みの確定クエリ(絞り込み計算のトリガー)。 */
  debouncedQuery: string;
  /** LOD閾値。ズーム率がこれ未満のときテーブルを代表行だけに間引く(左パネルで調整)。 */
  lodThreshold: number;
  /**
   * カメラ移動コマンド(Docs/設計-視点移動.md)。seq が変化したときだけ fitView を実行する。
   * null は「まだ何も発行されていない」初期状態(何もしない)。
   */
  cameraCommand: CameraCommand | null;
  /** テーブルノードをクリックしたときにフォーカスへ遷移させる。 */
  onSelectTable: (tableId: string) => void;
  /** 背景の空白クリック時にフォーカス解除する。 */
  onClearFocus: () => void;
  /** フォーカス起点テーブルID(このテーブルのみ編集可能)。 */
  focusOriginId?: string | null;
  /** 型入力候補(モデル中の既出型 + Enum名)。 */
  typeOptions?: string[];
  /** 現在開いている挿入入力行の状態(無ければどのテーブルにも表示しない)。 */
  pendingInsert?: PendingInsertState | null;
  /** 現在編集中の既存カラムの状態(無ければどのテーブルにも表示しない)。 */
  pendingEdit?: PendingEditState | null;
  /** 右クリックメニュー/ヘッダー[+]から挿入入力行を開く要求。 */
  onRequestInsert?: (
    tableId: string,
    anchorColumnId: string | null,
    anchorColumnName: string | null,
    position: InsertPosition,
  ) => void;
  /** 右クリックメニュー「削除」からのカラム削除要求(フォーカス起点テーブルのみ)。 */
  onRequestDelete?: (tableId: string, columnId: string, columnName: string) => void;
  /** 行ホバーの ▲▼ からのカラム並べ替え要求(フォーカス起点テーブルのみ)。 */
  onRequestMove?: (
    tableId: string,
    columnId: string,
    columnName: string,
    direction: MoveDirection,
  ) => void;
  /** ダブルクリック/F2から既存カラムの編集開始要求(どのテーブルからでも呼ばれる)。 */
  onRequestEdit?: (
    tableId: string,
    columnId: string,
    columnName: string,
    focusField: EditRowFocusField,
  ) => void;
  /** 挿入入力行の確定。 */
  onCommitInsert?: (input: ColumnInput) => void;
  /** 既存カラム編集の確定。 */
  onCommitEdit?: (input: ColumnInput) => void;
  /** 入力行(挿入/編集)の破棄。 */
  onCancelInsert?: () => void;
  /** カラム名の重複チェック(編集セッション中はApp側で自分自身を除外済み)。 */
  isDuplicateName?: (name: string) => boolean;
  /**
   * サイドカー由来の保存済み配置座標(テーブルID→座標)。ELKレイアウト結果より優先して
   * 採用する(あれば使う=設計原則3)。ここに無いテーブルは自動レイアウト座標のままにする。
   */
  savedPositions?: Record<string, { x: number; y: number }>;
  /**
   * テーブルをドラッグして配置が変わったときに、全テーブルの最新座標(テーブルID→座標)を通知する。
   * App 側でサイドカーへ debounce 保存する。
   */
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
  /**
   * サイドカー由来の保存済み列幅(テーブルID→{name?,type?,note?}px)。自動概算より優先して採用する。
   * 名前列も含め全列固定pxで持つ(Excel風リサイズのため1frはやめた)。ここに無い列は自動概算幅のまま。
   * 箱(ノード外形)の幅はユーザーが直接リサイズしないため、テーブル幅そのものの保存は無い
   * (常に列幅合計=estimateTableNodeSize から算出する)。
   */
  savedColumnWidths?: Record<string, TableColumnWidthOverride>;
  /**
   * カラム列幅(名前/型/note)を手動リサイズ/オートフィットしたときに、全テーブルの最新列幅を
   * 通知する。列幅を変えたテーブルのみ載る。App 側で保存する。
   */
  onColumnWidthsChange?: (columnWidths: Record<string, TableColumnWidthOverride>) => void;
}

// useReactFlow() は ReactFlow の子孫コンポーネントでのみ使えるため、
// Provider でラップした内側コンポーネントとして実装する。
// props(model/viewMode/debouncedQuery/コールバック)が変わらない限り
// 再レンダリングされないよう memo 化(検索キー入力中の負荷軽減)。
export const ErCanvas = memo(function ErCanvas(props: ErCanvasProps) {
  return (
    <ReactFlowProvider>
      <ErCanvasInner {...props} />
    </ReactFlowProvider>
  );
});

function ErCanvasInner({
  model,
  viewMode,
  debouncedQuery,
  lodThreshold,
  cameraCommand,
  onSelectTable,
  onClearFocus,
  focusOriginId = null,
  typeOptions = [],
  pendingInsert = null,
  pendingEdit = null,
  onRequestInsert,
  onRequestDelete,
  onRequestMove,
  onRequestEdit,
  onCommitInsert,
  onCommitEdit,
  onCancelInsert,
  isDuplicateName,
  savedPositions,
  onPositionsChange,
  savedColumnWidths,
  onColumnWidthsChange,
}: ErCanvasProps) {
  // layoutNodes は ELK による座標計算結果のみを持つ(モデルにつき1回だけ計算する)。
  // 実際に <ReactFlow> へ渡す nodes は、これに「編集中データ・濃淡(dimmed)」を都度マージした
  // 派生値にする(pendingInsert/型候補/コールバック/モード変化のたびに重いレイアウト計算を
  // やり直さないため)。
  //
  // 2026-07-13 決定: 「配置は一切動かさない。対象外は薄くする。カメラだけが対象にズームする」。
  // これによりモード変更(全体/絞り込み/フォーカス、ホップ数変更)では絶対に再レイアウトしない。
  const [layoutNodes, setLayoutNodes] = useState<TableNodeType[]>([]);
  // layoutNodes の最新値を ref でも持つ(ドラッグ完了/リサイズ確定の通知を setState updater の
  // 外=レンダーフェーズ外で行うため。updater 内で副作用を呼ぶと StrictMode で2回発火する)。
  // コミット後の useEffect で同期する。ドラッグ/リサイズ確定はユーザー操作イベントで発火し、
  // 直前フレームのコミット済み座標を読めればよいので、この同期タイミングで十分。
  const layoutNodesRef = useRef<TableNodeType[]>([]);
  const [edges, setEdges] = useState<Edge<RefEdgeData>[]>([]);
  const [isLayouting, setIsLayouting] = useState(false);
  // B2「自動レイアウト再実行」ボタンの再計算トリガー。model が同じでもこれをインクリメントすれば
  // 下のレイアウト useEffect を再発火できる。
  const [layoutSeq, setLayoutSeq] = useState(0);
  const { fitView } = useReactFlow();
  const modeColors = useModeColors();

  // サイドカー保存済み座標の最新値を ref で持つ(レイアウト useEffect の依存に入れると
  // 座標変化のたびに重い ELK 再計算が走ってしまうため、依存には入れず ref 経由で読む)。
  // レイアウト確定時、この ref にある座標は ELK 結果を上書きして採用する(設計原則3=あれば使う)。
  const savedPositionsRef = useRef(savedPositions);
  savedPositionsRef.current = savedPositions;

  // カラム列幅(名前/型/note)編集の状態管理は useColumnWidthState に集約する
  // (columnWidths state/ref・リサイズ/オートフィット確定処理の一式)。layoutNodesRef/
  // setLayoutNodes は ErCanvas 側が所有する ref/setter をそのまま渡す(ref 越し読み取りの
  // タイミングを変えないため)。
  const {
    columnWidths,
    columnWidthsRef: savedColumnWidthsRef,
    handleColumnWidthResize,
    handleColumnAutoFit,
  } = useColumnWidthState({
    model,
    savedColumnWidths,
    layoutNodesRef,
    setLayoutNodes,
    onColumnWidthsChange,
    onPositionsChange,
  });

  // layoutNodes の最新コミット値を ref に同期する(ドラッグ/リサイズ確定の通知で参照する)。
  useEffect(() => {
    layoutNodesRef.current = layoutNodes;
  }, [layoutNodes]);

  // LOD(詳細度切り替え)の状態管理は useLodState に集約する(閾値購読・操作中は切り替えない・
  // 操作終了後に少し待って確定、の一式)。onMoveStart/onMoveEnd は下の handleMoveStart/
  // handleMoveEnd から呼ぶ(markEvent 計測と合成)。
  const { isLod, onMoveStart: lodOnMoveStart, onMoveEnd: lodOnMoveEnd } = useLodState(lodThreshold);

  // 絞り込み結果(ヒットしたテーブル/カラム)。全体/フォーカスモードなら空集合。
  const filterResult = useMemo(() => {
    if (!model) return null;
    return perfSpan(
      '4|filter:検索絞り込み',
      () => filterModel(model, debouncedQuery),
      (r) => `${r.matchedTableIds.size}表ヒット`,
    );
  }, [model, debouncedQuery]);

  // 隣接グラフは model が変わらない限り不変なので、ホップ数変更のたびに
  // 再構築しないよう model のみをキーにメモ化する。
  const adjacencyGraph = useMemo(() => {
    if (!model) return null;
    return buildAdjacencyGraphFromModel(model);
  }, [model]);

  // フォーカスモードでのNホップ近傍テーブルID集合。
  const focusTableIds = useMemo(() => {
    if (!adjacencyGraph || viewMode.kind !== 'focus') return null;
    return findTablesWithinHops(adjacencyGraph, viewMode.tableId, viewMode.hops);
  }, [adjacencyGraph, viewMode]);

  // 「注目対象」テーブルID集合(全体モードなら null = 全部が注目対象=薄表示なし)。
  // 絞り込み: ヒットテーブル。フォーカス: 起点+Nホップ近傍。
  // 表示/非表示の切り替えではなく、この集合に含まれないテーブルを薄く見せるためだけに使う。
  const focusedTableIds = useMemo<ReadonlySet<string> | null>(() => {
    if (viewMode.kind === 'focus') return focusTableIds ?? new Set<string>();
    if (viewMode.kind === 'filter') return filterResult?.matchedTableIds ?? new Set<string>();
    return null;
  }, [viewMode, focusTableIds, filterResult]);

  // フォーカス起点テーブルの表示名(モードChip用)。
  const focusTableName = useMemo(() => {
    if (!model || viewMode.kind !== 'focus') return null;
    return model.tables.find((t) => t.id === viewMode.tableId)?.name ?? null;
  }, [model, viewMode]);

  // レイアウト未完了時に発行されたカメラコマンドの「種別」を一時保持し、
  // レイアウト完了(setLayoutNodes後)のタイミングで消化する。seq は発火検知のためだけの
  // 値なのでここでは持たない(種別のみで十分)。
  const pendingCameraTypeRef = useRef<CameraCommand['type'] | null>(null);

  // 保留中カメラコマンドの登録。fit-all は後続の fit-tables で上書きしない(fit-all 優先)。
  // B2(再レイアウト)の fit-all は「配置が変わるので全体フィット」(設計原則3)であり、
  // ELK計算中に左パネル操作(P1/P2)の fit-tables が割り込んでも打ち消されてはならないため。
  const enqueuePendingCamera = useCallback((type: CameraCommand['type']) => {
    if (pendingCameraTypeRef.current === 'fit-all') return;
    pendingCameraTypeRef.current = type;
  }, []);

  // カメラコマンドの実行本体(fit-all/fit-tables共通)。fit-tables は実行時点の
  // focusTableIds(起点+Nホップ、既存の近傍集合算出を再利用)を使う
  // (発行時点ではなく実行時点の集合を使ってよい、という設計方針どおり)。
  // 初回(ファイルを開いた直後の最初のフィット)はアニメーション無しで即座に全体表示する
  // (ズームで寄っていく初期演出が不要という判断/2026-07-14)。以降のモード切替や
  // 再レイアウトのカメラ移動は今まで通りアニメーション付き(350ms)にする。
  const hasFittedOnceRef = useRef(false);
  const runCameraCommand = useCallback(
    (type: CameraCommand['type']) => {
      // 初回だけ duration:0(いきなり全体表示)。2回目以降は 350ms のアニメーション。
      const duration = hasFittedOnceRef.current ? 350 : 0;
      hasFittedOnceRef.current = true;
      if (type === 'fit-tables' && viewMode.kind === 'focus') {
        const ids = focusTableIds ?? new Set<string>([viewMode.tableId]);
        const nodeRefs = [...ids].map((id) => ({ id }));
        if (nodeRefs.length > 0) {
          fitView({ nodes: nodeRefs, duration, padding: 0.1, maxZoom: 1 });
          return;
        }
        // 対象0件(近傍テーブルがノード上に見つからない)は無反応にせず全体フィットへフォールバック。
      }
      // fit-all、またはfit-tablesだがフォーカス中でない(発行後にモードが変わった)場合も全体フィット。
      fitView({ duration, padding: 0.1, maxZoom: 1 });
    },
    [viewMode, focusTableIds, fitView],
  );

  // cameraCommand(App/ErCanvas内ボタンが発行)の seq が変化したときだけ fitView する。
  // viewMode やノード集合の変化そのものには絶対に反応しない(Docs/設計-視点移動.md の実装原則)。
  useEffect(() => {
    if (!cameraCommand) return;
    if (isLayouting || layoutNodes.length === 0) {
      // レイアウト計算中、または未完了(例: ファイルを開いた直後でELK計算中)。
      // 古いノード位置に対してfitViewしてしまわないよう、完了後(pending消化)に回す。
      enqueuePendingCamera(cameraCommand.type);
      return;
    }
    requestAnimationFrame(() => runCameraCommand(cameraCommand.type));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraCommand?.seq]);

  // レイアウトは model につき1回だけ計算する(全テーブル・全リレーション対象)。
  // モード変更(絞り込み/フォーカス/ホップ数)では再計算しない = 配置は一切動かない。
  useEffect(() => {
    let cancelled = false;

    // 新しいモデル(=ファイルを開き直した/差し替えた)になったら初回フィット扱いに戻す。
    // これにより開き直すたびに「いきなり全体表示(アニメ無し)」で始まる。
    hasFittedOnceRef.current = false;

    if (!model || model.tables.length === 0) {
      setLayoutNodes([]);
      setEdges([]);
      return;
    }

    setIsLayouting(true);
    const allTables = model.tables;
    computeTableLayout(model).then((result) => {
      if (cancelled) return;
      // ref 越しの読み取り(savedColumnWidthsRef/savedPositionsRef)はこれまでどおり
      // ELK完了(=このコールバック実行時点)で行う。読み取った値はここから先、純粋関数
      // (erCanvasLayout.ts)への引数として渡すだけにする(読み取りタイミングは変えない)。
      const posById = new Map(result.nodes.map((n) => [n.id, n]));
      const savedCW = savedColumnWidthsRef.current;
      const saved = savedPositionsRef.current;

      // ここでは座標とテーブル本体のみを確定する。検索ハイライト・フォーカス起点・
      // 濃淡(dimmed)・編集中データは下の useMemo で都度マージする(モード変更のたびに
      // このレイアウト計算をやり直さないための分離)。
      const newNodes = buildLayoutNodes(allTables, posById, savedCW, saved);

      // リレーション線はテーブル中央ではなく、対応するカラム行のハンドルから出す。
      // 左右どちらの辺に付けるかは RefEdge が描画時に両ノードの実位置から決める(floating)。
      const tablesById = new Map(allTables.map((t) => [t.id, t]));
      const newEdges = buildLayoutEdges(model.refs, tablesById);

      setLayoutNodes(newNodes);
      setEdges(newEdges);
      setIsLayouting(false);
      // レイアウト完了直後に fitView するのはここではない。カメラ移動は
      // 「視点を動かすべき操作」が発行する cameraCommand 経由に一本化する(上のuseEffect)。
      // レイアウト完了待ちで保留されていたコマンド(B2や計算中の発行分)をここで消化する。
      const pendingType = pendingCameraTypeRef.current;
      if (pendingType) {
        pendingCameraTypeRef.current = null;
        requestAnimationFrame(() => runCameraCommand(pendingType));
      }
    }).catch((err) => {
      console.error('レイアウト計算に失敗しました', err);
      setIsLayouting(false);
    });

    return () => {
      cancelled = true;
    };
    // レイアウトはモデルが変わったとき、またはB2(再レイアウトボタン)で layoutSeq が
    // 変化したときだけ再計算する(モード変更では絶対に再計算しない)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, layoutSeq]);

  // フォーカス起点テーブルの右クリックメニュー/ヘッダー[+]から呼ばれる。
  // カラムIDからテーブルIDとカラム名も一緒に上位へ伝える(App側でPendingInsertStateを組み立てる)。
  const handleRequestInsertForTable = useCallback(
    (tableId: string) => (anchorColumn: DbmlColumn | null, position: InsertPosition) => {
      onRequestInsert?.(tableId, anchorColumn?.id ?? null, anchorColumn?.name ?? null, position);
    },
    [onRequestInsert],
  );

  // 右クリックメニュー「削除」から呼ばれる(フォーカス起点テーブルのみ配線)。
  const handleRequestDeleteForTable = useCallback(
    (tableId: string) => (column: DbmlColumn) => {
      onRequestDelete?.(tableId, column.id, column.name);
    },
    [onRequestDelete],
  );

  // 行ホバーの ▲▼ から呼ばれる(フォーカス起点テーブルのみ配線)。
  const handleRequestMoveForTable = useCallback(
    (tableId: string) => (column: DbmlColumn, direction: MoveDirection) => {
      onRequestMove?.(tableId, column.id, column.name, direction);
    },
    [onRequestMove],
  );

  // ダブルクリック/F2による編集開始要求。どのテーブルからも呼ばれる
  // (App側でフォーカス遷移+編集セッション開始を行う)。
  const handleRequestEditForTable = useCallback(
    (tableId: string) => (column: DbmlColumn, focusField: EditRowFocusField) => {
      onRequestEdit?.(tableId, column.id, column.name, focusField);
    },
    [onRequestEdit],
  );

  const emptyMatch: TableMatch = useMemo(
    () => ({ tableId: '', tableNameMatched: false, matchedColumnIds: new Set() }),
    [],
  );

  // ノードの data(編集中データ・ハイライト・濃淡・コールバック)を「テーブルID→data」マップとして
  // 座標(layoutNodes の position)から分離して算出する。
  //
  // 重要(チカチカ対策): ドラッグ移動中は onNodesChange → applyNodeChanges で layoutNodes の
  // position だけが毎フレーム変わる。data はその座標変化に依存しないので、依存配列から
  // 「座標が変わるたびに変化する値(=layoutNodes 全体)」を外し、テーブル本体(tables)にのみ
  // 依存させる。こうすると座標だけ動いたフレームでは data マップが再計算されず、下の nodes も
  // 同じ data 参照を使い回せる → React Flow は動かした1ノード以外を再レンダリングしない。
  //
  // tables は model 由来にする(layoutNodes 由来にすると、ドラッグ中 applyNodeChanges が
  // layoutNodes 配列を毎フレーム作り直すため tables も毎フレーム新配列になり、data マップの
  // 再計算を防げない)。model は props で座標変更では変わらないので、data マップは座標更新の
  // フレームでは再計算されない。model.tables の各 table 参照はレイアウト時に data.table へ
  // そのまま入るのと同一。
  const tables = useMemo(() => model?.tables ?? [], [model]);
  const nodeDataById = useMemo<Map<string, TableNodeData>>(() => {
    const map = new Map<string, TableNodeData>();
    for (const table of tables) {
      const id = table.id;
      const isFocusOrigin = focusOriginId != null && id === focusOriginId;
      const isPendingTarget = isFocusOrigin && pendingInsert?.tableId === id;
      const match = filterResult?.matchesByTableId.get(id) ?? emptyMatch;
      const dimmed = focusedTableIds != null && !focusedTableIds.has(id);

      let pendingForNode: PendingInsert | null = null;
      if (isPendingTarget && pendingInsert) {
        const anchorColumn = pendingInsert.anchorColumnId
          ? table.columns.find((c) => c.id === pendingInsert.anchorColumnId) ?? null
          : null;
        pendingForNode = { anchorColumn, position: pendingInsert.position };
      }

      let pendingEditForNode: PendingEdit | null = null;
      if (isFocusOrigin && pendingEdit?.tableId === id) {
        pendingEditForNode = { columnId: pendingEdit.columnId, focusField: pendingEdit.focusField };
      }

      map.set(id, {
        table,
        matchedColumnIds: match.matchedColumnIds,
        isFocusOrigin,
        dimmed,
        collapsed: isLod,
        typeOptions: isFocusOrigin ? typeOptions : undefined,
        pendingInsert: pendingForNode,
        pendingEdit: pendingEditForNode,
        onRequestInsert: isFocusOrigin ? handleRequestInsertForTable(id) : undefined,
        onRequestDelete: isFocusOrigin ? handleRequestDeleteForTable(id) : undefined,
        onRequestMove: isFocusOrigin ? handleRequestMoveForTable(id) : undefined,
        onRequestEdit: handleRequestEditForTable(id),
        onCommitInsert: isFocusOrigin ? onCommitInsert : undefined,
        onCommitEdit: isFocusOrigin ? onCommitEdit : undefined,
        onCancelInsert: isFocusOrigin ? onCancelInsert : undefined,
        isDuplicateName: isFocusOrigin ? isDuplicateName : undefined,
        // 列幅(名前/型/note)の現在の override と、列境界リサイズ/オートフィットのコールバック。
        // ローカル state(columnWidths)を single source of truth にする(確定即反映)。
        columnWidthOverride: columnWidths[id],
        onResizeColumn: handleColumnWidthResize,
        onAutoFitColumn: handleColumnAutoFit,
      });
    }
    return map;
  }, [
    tables,
    isLod,
    focusOriginId,
    pendingInsert,
    pendingEdit,
    typeOptions,
    filterResult,
    focusedTableIds,
    emptyMatch,
    handleRequestInsertForTable,
    handleRequestDeleteForTable,
    handleRequestMoveForTable,
    handleRequestEditForTable,
    handleColumnWidthResize,
    handleColumnAutoFit,
    columnWidths,
    onCommitInsert,
    onCommitEdit,
    onCancelInsert,
    isDuplicateName,
  ]);

  // 座標(layoutNodes)に data マップをマージして最終ノードを作る。data 参照は nodeDataById 由来
  // なので、ドラッグで座標だけ変わったフレームでは data 参照が保たれ、TableNode(memo)は
  // 動かした1個以外を再レンダリングしない。ここは軽い map なので毎フレーム走っても安い。
  //
  // フォーカス起点テーブルのみ、箱幅に ▲▼ 用の右ガター(MOVE_GUTTER_WIDTH)を足す
  // (Docs/設計-行オーバレイ.md 案2)。ガターは view 派生値であり、レイアウト状態
  // (layoutNodes の style.width)・押し出し判定・サイドカー保存には一切入れない。
  const nodes = useMemo<TableNodeType[]>(() => {
    return perfSpan(
      '5|render:ノード派生生成',
      () =>
        layoutNodes.map((node) => {
          const data = nodeDataById.get(node.id);
          if (!data) return node;
          if (data.isFocusOrigin && typeof node.style?.width === 'number') {
            return { ...node, data, style: { ...node.style, width: node.style.width + MOVE_GUTTER_WIDTH } };
          }
          return { ...node, data };
        }),
      (result) => `${result.length}ノード`,
    );
  }, [layoutNodes, nodeDataById]);

  // edges(座標確定済み)に濃淡(dimmed)をマージする。両端テーブルがともに注目対象集合に
  // 含まれる場合のみ通常表示、それ以外は薄く表示する。
  const displayEdges = useMemo<Edge<RefEdgeData>[]>(() => {
    if (!focusedTableIds) {
      // 全体モード: 薄表示なし。
      return edges.map((edge) => ({
        ...edge,
        data: edge.data ? { ...edge.data, dimmed: false } : edge.data,
      }));
    }
    return edges.map((edge) => {
      const dimmed = !focusedTableIds.has(edge.source) || !focusedTableIds.has(edge.target);
      return {
        ...edge,
        data: edge.data ? { ...edge.data, dimmed } : edge.data,
      };
    });
  }, [edges, focusedTableIds]);

  // テーブルノードクリックでフォーカスへ遷移(絞り込み中からのフォーカスも可)。
  const handleNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      onSelectTable(node.id);
    },
    [onSelectTable],
  );

  // 背景の空白クリックでフォーカス解除(全体モード/絞り込みモードでは何もしない)。
  const handlePaneClick = useCallback(() => {
    if (viewMode.kind === 'focus') {
      onClearFocus();
    }
  }, [viewMode, onClearFocus]);

  // 時系列トレース用の操作マーカー。記録中でなければ markEvent 内部で即 return する
  // (通常時のオーバーヘッドはほぼゼロ)。ドラッグ移動/パンは高頻度で呼ばれるが
  // markEvent 側で同種連続を間引くため、区間の開始/継続/終了だけが残る。
  const handleNodeDragStart = useCallback<OnNodeDrag<TableNodeType>>((_e, node) => {
    markEvent('drag:start', node.id);
  }, []);
  const handleNodeDrag = useCallback<OnNodeDrag<TableNodeType>>(() => {
    markEvent('drag:move');
  }, []);
  const handleNodeDragStop = useCallback<OnNodeDrag<TableNodeType>>(
    () => {
      markEvent('drag:stop');
      // ドラッグ中の追従は onNodesChange(position change)で layoutNodes に反映済み。
      // ここではドラッグ完了時に「確定した全テーブル座標」をサイドカー保存のため App へ通知するだけ。
      // 最新の layoutNodes から座標マップを作る(setter の関数形で最新値を確実に読む)。
      setLayoutNodes((prev) => {
        onPositionsChange?.(toPositionsMap(prev));
        return prev; // state は変えない(通知のためだけに最新値を読む)
      });
    },
    [onPositionsChange],
  );

  // React Flow のノード変更を layoutNodes に反映する。
  // position(ドラッグ移動)に加えて dimensions(measured サイズ確定)も必ず反映する。
  //
  // 重要(白フラッシュ対策): dimensions change を捨てると、ドラッグで nodes を再生成した際に
  // 各ノードの measured サイズが未確定に戻り、onlyRenderVisibleElements の可視判定が
  // 一瞬リセットされて全ノードが消える→再計測で戻る(=画面が一瞬白くなる)。measured を
  // layoutNodes に保持し続けることで、再生成後も可視判定が維持され、フラッシュが起きない。
  // select 等それ以外の変更はこのアプリでは不要なので無視する。
  const handleNodesChange = useCallback((changes: NodeChange<TableNodeType>[]) => {
    const relevant = changes.filter((c) => c.type === 'position' || c.type === 'dimensions');
    if (relevant.length === 0) return;
    setLayoutNodes((prev) => applyNodeChanges(relevant, prev));
  }, []);
  const handleMove = useCallback(() => {
    // パン/ズーム両方で発火する(ビューポート変化)。
    markEvent('viewport:move');
  }, []);
  const handleMoveStart = useCallback(() => {
    markEvent('viewport:start');
    lodOnMoveStart();
  }, [lodOnMoveStart]);
  const handleMoveEnd = useCallback(() => {
    markEvent('viewport:end');
    lodOnMoveEnd();
  }, [lodOnMoveEnd]);

  // B2「自動レイアウト再実行」ボタン。再計算をトリガーし、完了後に全体フィットする
  // (完了を待つ必要があるため保留登録しておく。レイアウト完了時の消化経路で実行される。
  //  保留済みが何であれ fit-all で確定させるため enqueue を介さず直接セットする)。
  const handleRelayoutClick = useCallback(() => {
    pendingCameraTypeRef.current = 'fit-all';
    setLayoutSeq((prev) => prev + 1);
  }, []);

  if (!model) {
    return (
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography variant="body1" color="text.secondary">
          「開く」ボタンから .dbml ファイルを選択してください
        </Typography>
      </Box>
    );
  }

  // 絞り込みモードでヒット0件のときは、全テーブルが薄くなるだけだと分かりにくいため、
  // 既存の「該当なし」オーバーレイを維持する(非表示にはしないので、それとは別に出す)。
  const showEmptyState =
    viewMode.kind === 'filter' && (filterResult?.matchedTableIds.size ?? 0) === 0 && !isLayouting;

  return (
    <Box sx={{ flex: 1, position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onMoveStart={handleMoveStart}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        // ビューポート外のノードをDOMから外す。拡大して一部だけ見えている状態で効く
        // (全体俯瞰=全テーブルが画面内のときは全要素が対象なので効果なし)。
        onlyRenderVisibleElements
        minZoom={0.05}
        // どこを掴んでもパンできるようにする(2026-07-14 決定)。左ドラッグでパン。
        // テーブル移動はヘッダー限定(各ノードの dragHandle: '.table-drag-handle')。
        // ヘッダー以外のノード領域は pointer-events:none にしてあり、mousedown が
        // ペインに素通りしてパンになる(TableNode 側でクリック系のみデリゲート受けする)。
        panOnDrag
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={modeColors.canvasDot} />
        <Controls showInteractive={false}>
          <ControlButton onClick={handleRelayoutClick} title="自動レイアウトを再実行">
            <RestartAltIcon />
          </ControlButton>
        </Controls>
        <MiniMap
          pannable
          zoomable
          maskColor={modeColors.minimapMask}
          nodeColor={(node) => (node.data?.dimmed ? modeColors.minimapNodeDimmed : modeColors.minimapNode)}
        />
      </ReactFlow>

      {showEmptyState && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <Typography variant="body1" color="text.secondary">
            該当なし
          </Typography>
        </Box>
      )}

      {/* 右上モード表示 */}
      <Box
        sx={{
          position: 'absolute',
          top: 12,
          right: 12,
        }}
      >
        {isLayouting ? (
          <Chip size="small" label="レイアウト計算中..." />
        ) : viewMode.kind === 'filter' ? (
          <Chip size="small" color="primary" label={`絞り込み: "${viewMode.query}"`} />
        ) : viewMode.kind === 'focus' ? (
          <Chip
            size="small"
            color="primary"
            label={`フォーカス: ${focusTableName ?? viewMode.tableId} (${viewMode.hops}ホップ)`}
          />
        ) : (
          <Chip size="small" label="全体" />
        )}
      </Box>
    </Box>
  );
}
