// ER図のテーブルノード。UI設計.md の「D. テーブルノード」に準拠。
// PK/FKアイコン + カラム名 + 型を表示する。全カラムを表示する(内部スクロールなし)。
// パフォーマンス: ツールチップは MUI Tooltip でなく native の title 属性を使う。
// 大規模データではカラム行×アイコン/noteで数百個の Tooltip が生成され描画が重くなるため。
//
// フェーズ4(追加): フォーカス起点テーブルのみ、カラム行の右クリックで「上/下に追加」の
// コンテキストメニューを出せる。ヘッダーの[+]は末尾追加のショートカット。
// 選択すると挿入位置に ColumnEditRow(インライン入力行)を表示する。
//
// フェーズ4(既存カラム編集):
// - 任意のテーブルのカラム行を「ダブルクリック」→ そのテーブルにフォーカスしつつ行全体が編集状態になる
//   (ダブルクリックしたセル=名前/型/note に初期カーソルを合わせる)。
// - フォーカス起点テーブルでは行クリックで行選択(控えめハイライト)、F2 で選択行を編集状態にする。
//
// カラム並べ替え(2026-07-14 ユーザー決定): フォーカス起点テーブルの行にマウスを乗せたときだけ、
// 行の右端に ▲▼ ボタンを出す(1クリック=1行移動)。全体/絞り込みモードでは出さないので図が汚れない。
// ドラッグ&ドロップ方式は採らない(React Flow のノードドラッグ/パンとの競合を避ける)。
//
// 既知の挙動(2026-07-14 確認済み・現状維持でユーザー了承済み。バグではないので「直さない」):
// - カーソルを固定したまま ▼ を連打すると、カラムは下がり続けず1行分を往復する。移動後その
//   画面位置は「入れ替わった隣のカラムの行」になるため、2回目のクリックはそのカラムを下げる
//   =元に戻す操作になる。クリック単体はどれも行の意味として正しい。マウスで複数行動かすには
//   1クリックごとにカーソルを1行分ずらす必要がある。
// - ただしクリック後はフォーカスが移動したカラムの ▼ に追従する(行が key=col.id ごと DOM 移動
//   するため)。そのまま Enter を押し続けると同じカラムが下がり続け、往復しない。
//
// ▲▼ の配置(2026-07-14 決定、Docs/設計-行オーバレイ.md 案2): フォーカス起点テーブルのみ、
// 箱幅に右ガター(MOVE_GUTTER_WIDTH)が足され(ErCanvas 側)、▲▼ はそのガター内に出る。
// note セル(最右列)には重ならないため、note のダブルクリック編集を奪わない。
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Box, Divider, IconButton, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import type { DbmlColumn, DbmlTable } from '../parser/model';
import type { MoveDirection } from '../edit/moveColumn';
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  ICON_COL_WIDTH,
  MOVE_GUTTER_WIDTH,
  ROW_PADDING_X,
  MIN_TABLE_WIDTH,
  BODY_BOTTOM_PADDING,
  BASE_FONT_SIZE,
  computeColumnWidths,
  computeRowMetrics,
  computeCollapsedFontSize,
  noteLines,
  type TableRowMetrics,
} from '../layout/nodeSize';
import { estimateTableNodeSize } from '../layout';
import { ColumnEditRow, type EditRowFocusField } from './ColumnEditRow';
import { ColumnResizeHandles } from './ColumnResizeHandles';
import { useColumnResize } from './useColumnResize';
import { ColumnRow } from './ColumnRow';
import type { ColumnInput } from '../edit/lineFormat';
import type { InsertPosition } from '../edit/insertColumn';
import { useModeColors } from '../theme/ModeColorsContext';

export interface PendingInsert {
  /** 挿入位置の基準となるカラム(null なら 'end' = テーブル末尾)。 */
  anchorColumn: DbmlColumn | null;
  position: InsertPosition;
}

export interface PendingEdit {
  /** 編集対象のカラムID。 */
  columnId: string;
  /** 初期フォーカスセル。 */
  focusField: EditRowFocusField;
}

export interface TableNodeData {
  table: DbmlTable;
  /** 検索でヒットしたカラムID(ハイライト対象)。未指定/空なら通常表示。 */
  matchedColumnIds?: Set<string>;
  /** フォーカスモードの起点テーブルかどうか(ボーダーを強調表示する)。編集可能テーブルでもある。 */
  isFocusOrigin?: boolean;
  /**
   * 表示対象外(絞り込み非ヒット/フォーカス近傍外)として薄く表示するかどうか。
   * レイアウトは動かさず、濃淡だけでモードを表現する方針(2026-07-13 決定)。
   * 薄い状態でもクリック/ダブルクリック等の操作は従来通り有効。
   */
  dimmed?: boolean;
  /**
   * LOD: 縮小表示中(ズーム率が閾値未満)かどうか。true のとき全カラムを描かず、
   * 代表行(PK/FK)だけに間引いてDOM要素数を減らす。外形サイズは通常時と同一に保つ。
   */
  collapsed?: boolean;
  /** 型入力の候補(モデル中の既出型 + Enum名)。 */
  typeOptions?: string[];
  /** このテーブルで現在開いている挿入入力行(無ければ非表示)。 */
  pendingInsert?: PendingInsert | null;
  /** このテーブルで現在編集中の既存カラム(無ければ非表示)。 */
  pendingEdit?: PendingEdit | null;
  /** 挿入入力行を開く要求(右クリックメニュー選択 / ヘッダー[+]クリック時)。 */
  onRequestInsert?: (anchorColumn: DbmlColumn | null, position: InsertPosition) => void;
  /** カラム削除要求(右クリックメニュー「削除」)。App側で確認ダイアログ→最小編集削除を行う。 */
  onRequestDelete?: (column: DbmlColumn) => void;
  /**
   * カラムの並べ替え要求(行ホバーで出る ▲▼ ボタン)。フォーカス起点テーブルでのみ表示する。
   * App側で最小編集(隣接する定義行のスワップ)を行う。
   */
  onRequestMove?: (column: DbmlColumn, direction: MoveDirection) => void;
  /**
   * 既存カラムの編集開始要求(ダブルクリック / F2)。
   * フォーカス起点以外のテーブルからも呼ばれる(App側でフォーカス遷移してから編集状態にする)。
   */
  onRequestEdit?: (column: DbmlColumn, focusField: EditRowFocusField) => void;
  /** 挿入入力行の確定。 */
  onCommitInsert?: (input: ColumnInput) => void;
  /** 既存カラム編集の確定。 */
  onCommitEdit?: (input: ColumnInput) => void;
  /** 入力行(挿入/編集どちらも)の破棄。 */
  onCancelInsert?: () => void;
  /** カラム名の重複チェック(編集時はApp側で自分自身を除外済み)。 */
  isDuplicateName?: (name: string) => boolean;
  /**
   * このテーブルの保存済み列幅(名前/型/note の手動リサイズ分)。あれば自動概算より優先して使う。
   * Excel風リサイズのため名前列も絶対px幅を持つ(1frではなく全列固定px)。
   */
  columnWidthOverride?: { name?: number; type?: number; note?: number };
  /**
   * カラム列幅(名前/型/note)の手動リサイズ確定(列境界ハンドルを離したとき)。newWidth は px。
   * ドラッグ中は TableNode 内ローカル state で見た目だけ変え、離した瞬間に一度だけ呼ぶ。
   */
  onResizeColumn?: (tableId: string, field: 'name' | 'type' | 'note', newWidth: number) => void;
  /**
   * 列境界のダブルクリックで、その列を実測した内容幅にフィットさせる(Excelのオートフィット)。
   * measuredWidth は TableNode 側で Range 計測した実測px(呼び出し側はこの値を override として
   * 保存する。ただし自動概算とほぼ一致する場合は override を落として自動概算に委ねる)。
   */
  onAutoFitColumn?: (tableId: string, field: 'name' | 'type' | 'note', measuredWidth: number) => void;
  [key: string]: unknown;
}

export type TableNodeType = Node<TableNodeData, 'table'>;

/** カラム行ハンドルのID(ErCanvas側のエッジ生成と対で使う)。 */
export function columnHandleId(columnId: string, side: 'left' | 'right'): string {
  return `${columnId}__${side}`;
}

// カラム行の左右に置く不可視ハンドル。接続操作には使わないため pointerEvents も切る。
const columnHandleStyle = {
  opacity: 0,
  pointerEvents: 'none' as const,
};

/**
 * note の先頭行だけを返す(テーブルnote=ヘッダーの日本語表名併記とLOD表示で使う。
 * 高さが固定のヘッダーに複数行は入らないため、こちらは先頭行のみ + 全文はツールチップ)。
 * カラムnoteは複数行そのまま表示するのでこの関数は通さない。
 * 分割規則は noteLines に一本化する(内部モデルの改行はリテラル `\n` で現れるため)。
 */
function firstLine(text: string): string {
  const lines = noteLines(text);
  return lines.length > 1 ? `${lines[0]}…` : lines[0];
}

/** ツールチップ用に note の全文を実改行へ開く(リテラル `\n` が生で見えないように)。 */
function noteTooltip(note: string): string {
  return noteLines(note).join('\n');
}

/** ダブルクリックされた要素から初期フォーカスセルを判定する(data-cell属性ベース)。 */
function focusFieldFromEvent(e: React.MouseEvent): EditRowFocusField {
  const el = (e.target as Element | null)?.closest?.('[data-cell]');
  const cell = el?.getAttribute('data-cell');
  if (cell === 'type' || cell === 'note' || cell === 'default' || cell === 'name') return cell;
  return 'name';
}

interface RowContextMenuState {
  mouseX: number;
  mouseY: number;
  column: DbmlColumn;
}

/**
 * 省略表示(LOD)時のFKカラム不可視ハンドル。カラム行を描かないため、行相当の縦位置(top)を
 * 明示指定して同じIDのハンドルを本体エリアに置く。IDは通常時と同一なので、エッジの
 * source/targetHandle 参照が切れず、リレーション線が消えない(端点位置もほぼ維持される)。
 */
function CollapsedColumnHandles({ col, top }: { col: DbmlColumn; top: number }) {
  return (
    <>
      <Handle type="source" position={Position.Left} id={columnHandleId(col.id, 'left')} style={{ ...columnHandleStyle, top }} />
      <Handle type="target" position={Position.Left} id={columnHandleId(col.id, 'left')} style={{ ...columnHandleStyle, top }} />
      <Handle type="source" position={Position.Right} id={columnHandleId(col.id, 'right')} style={{ ...columnHandleStyle, top }} />
      <Handle type="target" position={Position.Right} id={columnHandleId(col.id, 'right')} style={{ ...columnHandleStyle, top }} />
    </>
  );
}

interface CollapsedTableBodyProps {
  table: DbmlTable;
  rowMetrics: TableRowMetrics;
  /** LOD時のテーブル名フォントサイズ(px)。nodeSize.computeCollapsedFontSize で概算済み。 */
  bodyFontSize: number;
}

/**
 * LOD(縮小)時の本体ブロック。カラム行は一切描かず、本体エリアいっぱいにテーブル名を大きく
 * 表示する。遠目でも「どこに何の表があるか」が分かることを最優先し、DOM要素数も最小にする
 * (2026-07-14 ユーザー決定)。本体の高さは通常時と一致させ、外形サイズを保つ。
 */
function CollapsedTableBody({ table, rowMetrics, bodyFontSize }: CollapsedTableBodyProps) {
  return (
    <Box
      sx={{
        // 本体高 = 全カラム表示時と同じ高さ(全行分。複数行noteで伸びた分も含む)。
        // ヘッダーは上に別途ある。nodeSize.ts の estimateTableNodeSize と一致させること。
        height: rowMetrics.total + BODY_BOTTOM_PADDING,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // 表名+日本語名は上寄せで表示する(2026-07-14 ユーザー要望。
        // カラム数が多く縦長の箱で名前が中央に沈むと、遠目でヘッダー直下に名前が見えず探しづらいため)。
        justifyContent: 'flex-start',
        pt: 0.5,
        px: 1,
        overflow: 'hidden',
        // FKカラムの不可視ハンドルを通常時と同じ縦位置に絶対配置するための基準。
        position: 'relative',
      }}
    >
      {/* 省略表示でもリレーション線を消さない: Refに登場するFKカラムのハンドルを、
          通常時(=カラム行)と同じ縦位置に残す。カラム行そのものは描かないため、
          各カラムの行中央(rowMetrics の積み上げ位置 + その行の高さの半分)にhandleだけを置く。
          これで省略前後で線の端点がほぼ動かない(2026-07-14 ユーザー決定: 案1)。 */}
      {table.columns.map((col, idx) =>
        col.isForeignKey ? (
          <CollapsedColumnHandles key={col.id} col={col} top={rowMetrics.offsets[idx] + rowMetrics.heights[idx] / 2} />
        ) : null,
      )}
      <Typography
        title={table.name}
        sx={{
          fontSize: bodyFontSize,
          fontWeight: 700,
          lineHeight: 1.05,
          color: 'text.primary',
          textAlign: 'center',
          maxWidth: '100%',
          // 省略は絶対に出さない。長い/アンダースコア入りの名前は折り返して全文見せる
          // (アンダースコアやハイフンの位置で改行できるよう anywhere を許可)。
          whiteSpace: 'normal',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {table.name}
      </Typography>
      {/* 日本語テーブル名(note)を英名の下に小さめで併記する(2026-07-14 ユーザー要望)。
          サイズは英名に連動(約40%、下限10px)。長い場合も省略せず折り返して見せる。 */}
      {table.note && (
        <Typography
          title={noteTooltip(table.note)}
          sx={{
            fontSize: Math.max(10, Math.round(bodyFontSize * 0.4)),
            fontWeight: 400,
            lineHeight: 1.2,
            color: 'text.primary',
            textAlign: 'center',
            maxWidth: '100%',
            mt: 0.25,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }}
        >
          {firstLine(table.note)}
        </Typography>
      )}
    </Box>
  );
}

function TableNodeImpl({ data }: NodeProps<TableNodeType>) {
  const {
    table,
    matchedColumnIds,
    isFocusOrigin,
    dimmed,
    collapsed,
    typeOptions,
    pendingInsert,
    pendingEdit,
    onRequestInsert,
    onRequestDelete,
    onRequestMove,
    onRequestEdit,
    onCommitInsert,
    onCommitEdit,
    onCancelInsert,
    isDuplicateName,
    columnWidthOverride,
    onResizeColumn,
    onAutoFitColumn,
  } = data;

  const [menuState, setMenuState] = useState<RowContextMenuState | null>(null);
  // 行選択(F2編集の対象)。フォーカス起点テーブルでのみ意味を持つ。
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  // 列幅ドラッグ中のみ入るローカル列幅プレビュー(名前/型/note)。null=非ドラッグ。
  const [resizingCols, setResizingCols] = useState<{ name?: number; type?: number; note?: number } | null>(null);
  // インライン編集中の入力内容が必要とする列幅(ColumnEditRow から入力のたびに通知される)。
  // 現在の列幅を超えた列だけライブで広げ、編集中のテキストが切れないようにする
  // (2026-07-14 ユーザー決定「切れないこと最優先」。Docs/設計-行オーバレイ.md)。
  // 全行共通のグリッドテンプレートごと広げるため、表示行との列位置は揃ったまま。null=非編集。
  const [editCols, setEditCols] = useState<{ name: number; type: number; note: number } | null>(null);
  const modeColors = useModeColors();

  // カラム行グリッド(アイコン | 名前 | 型 | note)の列幅。各列は保存済み override があれば
  // それを、無ければテーブル内最大値で決める。全行で同じテンプレートを使い列の左端を縦に揃える。
  // Excel風リサイズのため名前列も絶対px(1frではない)。列ドラッグ中は resizingCols を最優先。
  const columnWidths = useMemo(() => {
    const base = computeColumnWidths(table, columnWidthOverride);
    const current = !resizingCols
      ? base
      : {
          name: resizingCols.name != null ? resizingCols.name : base.name,
          type: resizingCols.type != null ? resizingCols.type : base.type,
          // note 列が存在する(base.note>0)ときだけプレビュー幅を効かせる。
          note: base.note > 0 && resizingCols.note != null ? resizingCols.note : base.note,
        };
    if (!editCols) return current;
    // 編集中の内容が現在幅を超えた列だけ広げる(縮める方向には効かせない)。
    // note 入力欄は行右端側へ +52px(ROW_PADDING_X + MOVE_GUTTER_WIDTH)延長済みなので、
    // その延長で足りない分だけ note 列を広げる。
    return {
      name: Math.max(current.name, editCols.name),
      type: Math.max(current.type, editCols.type),
      note:
        current.note > 0
          ? Math.max(current.note, editCols.note - (ROW_PADDING_X + MOVE_GUTTER_WIDTH))
          : current.note,
    };
  }, [table, columnWidthOverride, resizingCols, editCols]);
  // カラム行の高さ(複数行noteの行は縦に伸びる)と各行の積み上げ位置。行高・ハンドル位置・
  // 本体エリア高は全てここから引く。estimateTableNodeSize(ノード高さ)も同じ関数を使うため、
  // 箱の高さと中身の合計高が必ず一致する。
  const rowMetrics = useMemo(() => computeRowMetrics(table), [table]);

  // 名前列も含め全列固定px(Excel風リサイズのため1frはやめる)。ノード幅は列幅合計に
  // estimateTableNodeSize が常時追従するので、箱と列テンプレートがズレることはない。
  const rowGridTemplate = useMemo(() => {
    const base = `${ICON_COL_WIDTH}px ${columnWidths.name}px ${columnWidths.type}px`;
    return columnWidths.note > 0 ? `${base} ${columnWidths.note}px` : base;
  }, [columnWidths]);

  // 列ドラッグ中(resizingCols あり)だけ箱幅をローカルで先取りプレビューする。
  // 確定前は親(node style.width)がまだ古い幅のままなので、これが無いと固定pxテンプレートが
  // 箱からはみ出て右側の列が見切れる。columnWidths は既にプレビュー込みの実効値なので
  // そのまま estimateTableNodeSize に渡せる。確定後は resizingCols が null に戻り、
  // 従来どおり親の style.width に委ねる。
  const previewWidth = useMemo(() => {
    // 列ドラッグ中、またはインライン編集で列がライブ拡張され得る間だけ箱幅を先取りする。
    if (!resizingCols && !editCols) return null;
    const base = estimateTableNodeSize(table, {
      name: columnWidths.name,
      type: columnWidths.type,
      note: columnWidths.note > 0 ? columnWidths.note : undefined,
    }).width;
    // フォーカス起点は親(ErCanvas)が style.width に ▲▼ 用の右ガターを足しているため、
    // プレビューも同じだけ足して確定時に箱幅が跳ねないようにする。
    return isFocusOrigin ? base + MOVE_GUTTER_WIDTH : base;
  }, [resizingCols, editCols, table, columnWidths, isFocusOrigin]);

  // LOD(縮小)時、本体エリアに収まる範囲でテーブル名を最大化するフォントサイズ(px)を概算する。
  // 最優先は「表名が省略されず必ず箱の幅に収まる」こと(遠目で表名が読めるのが目的。
  // 2026-07-14 ユーザー決定: 縮小時はヘッダー + 大きな表名のみ)。純粋計算は nodeSize.ts 側
  // (computeCollapsedFontSize)に集約し、ここでは collapsed=false 時のガードのみ持つ。
  const bodyFontSize = useMemo(() => {
    if (!collapsed) return 0;
    return computeCollapsedFontSize(table, columnWidthOverride);
  }, [collapsed, table, columnWidthOverride]);

  const editable = !!isFocusOrigin && !!onRequestInsert;
  // 編集行(挿入/既存編集)を開いている間は浮遊オーバレイ(▲▼・列リサイズハンドル)を出さない
  // (設計-行オーバレイ.md 原則5。編集は一度に1行なので並べ替え/リサイズと同時には使わない)。
  const editRowOpen = !!pendingEdit || !!pendingInsert;
  // 並べ替え ▲▼ を出す条件: フォーカス起点テーブルのみ(全体/絞り込みモードでは出さない)。
  // LOD(縮小)時はカラム行自体を描かないので自動的に対象外。
  const reorderable = !!isFocusOrigin && !!onRequestMove && !editRowOpen;

  // 編集行が閉じたら(確定/破棄どちらでも)ライブ拡張を解除して元の列幅へ戻す。
  // 確定時は再パース後の新しい内容で自動幅が再計算されるので、内容ぶんの幅は保たれる。
  useEffect(() => {
    if (!editRowOpen) setEditCols(null);
  }, [editRowOpen]);
  const handleEditContentWidths = useCallback(
    (widths: { name: number; type: number; note: number }) => setEditCols(widths),
    [],
  );

  // フォーカス起点でなくなったら行選択を解除する。
  useEffect(() => {
    if (!editable) setSelectedColumnId(null);
  }, [editable]);

  // F2: 選択行を編集状態にする(編集行が既に開いているときは何もしない)。
  useEffect(() => {
    if (!editable || !selectedColumnId || !onRequestEdit) return;
    if (pendingEdit || pendingInsert) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      // 検索欄など他の入力要素にフォーカスがある間は発火させない。
      const target = e.target as Element | null;
      if (target?.closest?.('input, textarea, select')) return;
      const col = table.columns.find((c) => c.id === selectedColumnId);
      if (col) {
        e.preventDefault();
        onRequestEdit(col, 'name');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editable, selectedColumnId, onRequestEdit, pendingEdit, pendingInsert, table]);

  const closeMenu = useCallback(() => setMenuState(null), []);

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent, column: DbmlColumn) => {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      setMenuState({ mouseX: e.clientX, mouseY: e.clientY, column });
    },
    [editable],
  );

  // 行クリック: フォーカス起点テーブルでは行選択(ノードクリック=再フォーカスに化けないよう伝播停止)。
  // それ以外のテーブルでは何もせず伝播させる(従来どおりノードクリック→フォーカス遷移)。
  const handleRowClick = useCallback(
    (e: React.MouseEvent, column: DbmlColumn) => {
      if (!editable) return;
      e.stopPropagation();
      setSelectedColumnId(column.id);
    },
    [editable],
  );

  // 行ダブルクリック: どのテーブルでも編集開始を要求する(App側でフォーカス遷移+編集状態セット)。
  const handleRowDoubleClick = useCallback(
    (e: React.MouseEvent, column: DbmlColumn) => {
      if (!onRequestEdit) return;
      e.stopPropagation();
      onRequestEdit(column, focusFieldFromEvent(e));
    },
    [onRequestEdit],
  );

  const handleHeaderAddClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRequestInsert?.(null, 'end');
    },
    [onRequestInsert],
  );

  const handleMenuSelect = useCallback(
    (position: InsertPosition) => {
      if (menuState) {
        onRequestInsert?.(menuState.column, position);
      }
      closeMenu();
    },
    [menuState, onRequestInsert, closeMenu],
  );

  const handleMenuDelete = useCallback(() => {
    if (menuState) {
      onRequestDelete?.(menuState.column);
    }
    closeMenu();
  }, [menuState, onRequestDelete, closeMenu]);

  // 列境界ドラッグ(Excel風の伸縮)とダブルクリック(オートフィット)は useColumnResize に集約する。
  // rootRef(ズーム率補正の基準要素)もこのフックが所有し、ルート Box の ref にそのまま渡す。
  const { rootRef, makeColumnResizeMouseDown, makeColumnAutoFit } = useColumnResize({
    tableId: table.id,
    columnWidths,
    onResizeColumn,
    onAutoFitColumn,
    setResizingCols,
  });

  // 挿入入力行(showInsertAbove / showInsertBelow / カラム0件時の末尾)は props が完全一致のため
  // ローカル関数に統合する。rowHeight のみ呼び出し側ごとに異なる(追加行はまだ表示行が無いので
  // 基準の ROW_HEIGHT を使う)。ColumnRow(memo化済み)へ props として渡るため、参照を
  // useCallback で安定させて全カラム行の再レンダーを誘発しないようにする。
  const renderInsertRow = useCallback(
    (rowHeight: number) => (
      <ColumnEditRow
        typeOptions={typeOptions ?? []}
        onCommit={(input) => onCommitInsert?.(input)}
        onCancel={() => onCancelInsert?.()}
        isDuplicateName={(name) => isDuplicateName?.(name) ?? false}
        gridTemplate={rowGridTemplate}
        rowHeight={rowHeight}
        hasNoteColumn={columnWidths.note > 0}
        onContentWidthsChange={handleEditContentWidths}
      />
    ),
    [
      typeOptions,
      onCommitInsert,
      onCancelInsert,
      isDuplicateName,
      rowGridTemplate,
      columnWidths.note,
      handleEditContentWidths,
    ]
  );

  return (
    <Box
      ref={rootRef}
      sx={{
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: isFocusOrigin ? 'primary.main' : 'divider',
        borderWidth: isFocusOrigin ? 2 : 1,
        bgcolor: 'background.paper',
        boxShadow: isFocusOrigin ? 6 : 3,
        minWidth: MIN_TABLE_WIDTH,
        // リサイズハンドル(position:absolute)の位置基準。
        position: 'relative',
        // 箱(ノード外形)の幅は常に列幅合計(estimateTableNodeSize)に追従する。
        // ユーザーが箱を直接リサイズすることはない(列単位のリサイズに一本化=決定事項)。
        // 列ドラッグ中だけ previewWidth でローカル先取り(親の style.width 反映を待たない)。
        ...(previewWidth != null ? { width: previewWidth } : null),
        overflow: 'hidden',
        fontSize: BASE_FONT_SIZE,
        // 対象外(絞り込み非ヒット/フォーカス近傍外)は薄く表示する。配置は動かさず、
        // 濃淡のみでモードを表現する(2026-07-13 決定)。opacity は CSS transition で滑らかに変化させる。
        opacity: dimmed ? 0.2 : 1,
        transition: 'opacity 0.2s ease',
        // 列境界ハンドルはホバー時のみ薄く見せる(常時表示だと大量テーブルで描画が重くなるため)。
        // 非表示中は pointer-events も切る(opacity はヒットテストに影響しないため、見えない
        // オーバレイがクリックを奪わないように。設計-行オーバレイ.md 原則6)。
        '&:hover .column-resize-handle': { opacity: 0.5, pointerEvents: 'auto' },
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />

      {/* 列境界リサイズハンドル(ColumnResizeHandles に抽出)。LOD中・編集行表示中は出さない。
          ドラッグ中は resizingCols 込みの columnWidths(プレビュー値)で追従するため、
          確定前でもハンドル位置が動いた列に付いてくる。 */}
      {!collapsed && onResizeColumn && !editRowOpen && (
        <ColumnResizeHandles
          columnWidths={columnWidths}
          bodyHeight={rowMetrics.total}
          onMouseDown={makeColumnResizeMouseDown}
          onAutoFit={makeColumnAutoFit}
        />
      )}

      <Stack
        direction="row"
        // ウィンドウのタイトルバー相当。このヘッダーを掴んだときだけノード移動になる
        // (ErCanvas 側で dragHandle: '.table-drag-handle' を指定)。それ以外の場所は
        // React Flow のパン(スクロール)に回る。
        className="table-drag-handle"
        sx={{
          alignItems: 'center',
          justifyContent: 'space-between',
          height: HEADER_HEIGHT,
          px: 1.5,
          bgcolor: 'primary.dark',
          color: 'primary.contrastText',
          cursor: 'move',
        }}
      >
        {/* 箱幅はカラム内容のみで決まる(estimateTableNodeSize はヘッダー幅を見ない)ため、
            収まらないヘッダーは「…」で省略する(全文は title ツールチップ)。minWidth: 0 が
            無いと flex アイテムがテキストの実幅未満に縮まず、省略されずに端で切れる。
            note(日本語名)側の flexShrink を大きくし、表名より先に譲らせる。 */}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', minWidth: 0 }}>
          <Typography variant="subtitle2" noWrap title={table.name} sx={{ minWidth: 0 }}>
            {table.name}
          </Typography>
          {table.note && (
            <Typography
              variant="caption"
              noWrap
              sx={{ opacity: 0.85, minWidth: 0, flexShrink: 3 }}
              title={noteTooltip(table.note)}
            >
              {firstLine(table.note)}
            </Typography>
          )}
        </Stack>
        {editable && (
          <Tooltip title="末尾にカラムを追加">
            <IconButton
              size="small"
              className="nodrag"
              onClick={handleHeaderAddClick}
              sx={{ color: 'inherit', p: 0.25 }}
            >
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <Box>
        {collapsed ? (
          <CollapsedTableBody table={table} rowMetrics={rowMetrics} bodyFontSize={bodyFontSize} />
        ) : table.columns.map((col, idx) => {
          const isHighlighted = matchedColumnIds?.has(col.id) ?? false;
          const isSelected = editable && selectedColumnId === col.id;
          const isLast = idx === table.columns.length - 1;
          const isEditingRow = pendingEdit?.columnId === col.id;
          const showInsertAbove =
            pendingInsert && pendingInsert.position === 'above' && pendingInsert.anchorColumn?.id === col.id;
          // 'end'(テーブル末尾への追加、ヘッダー[+]や末尾アンカーでの「下に追加」相当)は
          // アンカーカラムを持たないため、最後のカラム行の下に表示する。
          const showInsertBelow =
            (pendingInsert && pendingInsert.position === 'below' && pendingInsert.anchorColumn?.id === col.id) ||
            (pendingInsert && pendingInsert.position === 'end' && pendingInsert.anchorColumn === null && isLast);

          return (
            <ColumnRow
              key={col.id}
              col={col}
              idx={idx}
              isLast={isLast}
              isHighlighted={isHighlighted}
              isSelected={isSelected}
              isEditingRow={isEditingRow}
              editFocusField={isEditingRow && pendingEdit ? pendingEdit.focusField : 'name'}
              showInsertAbove={!!showInsertAbove}
              showInsertBelow={!!showInsertBelow}
              rowGridTemplate={rowGridTemplate}
              rowHeight={rowMetrics.heights[idx]}
              hasNoteColumn={columnWidths.note > 0}
              reorderable={reorderable}
              searchHighlightColor={modeColors.searchHighlight}
              typeOptions={typeOptions ?? []}
              renderInsertRow={renderInsertRow}
              onRowClick={handleRowClick}
              onRowDoubleClick={handleRowDoubleClick}
              onRowContextMenu={handleRowContextMenu}
              onRequestMove={onRequestMove}
              onCommitEdit={onCommitEdit}
              onCancelInsert={onCancelInsert}
              isDuplicateName={isDuplicateName}
              onContentWidthsChange={handleEditContentWidths}
            />
          );
        })}
        {/* テーブルにカラムが1つも無い場合の末尾入力行(理論上は稀だが防御的に対応)。 */}
        {table.columns.length === 0 &&
          pendingInsert &&
          pendingInsert.position === 'end' &&
          renderInsertRow(ROW_HEIGHT)}
      </Box>

      <Menu
        open={menuState !== null}
        onClose={closeMenu}
        anchorReference="anchorPosition"
        anchorPosition={menuState ? { top: menuState.mouseY, left: menuState.mouseX } : undefined}
        onContextMenu={(e) => e.preventDefault()}
      >
        <MenuItem onClick={() => handleMenuSelect('above')}>上に追加</MenuItem>
        <MenuItem onClick={() => handleMenuSelect('below')}>下に追加</MenuItem>
        <Divider />
        <MenuItem onClick={handleMenuDelete} sx={{ color: 'error.main' }}>
          カラムを削除
        </MenuItem>
      </Menu>
    </Box>
  );
}

// 大規模データ(数十テーブル)でも操作がもたつかないようmemo化。
export const TableNode = memo(TableNodeImpl);
