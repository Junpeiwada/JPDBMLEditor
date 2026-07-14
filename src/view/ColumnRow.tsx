// カラム行(1行分)の表示/編集切り替え。TableNode の table.columns.map 本体から抽出。
// 行クリック/ダブルクリック/右クリック、▲▼並べ替え、PK/FKアイコン、name/type/note セルを持つ。
// 挿入入力行(上/下、pendingInsert)は呼び出し側の renderInsertRow をそのまま挟み込む。
import { memo } from 'react';
import type { ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Box, IconButton, Stack, Typography } from '@mui/material';
import KeyIcon from '@mui/icons-material/VpnKey';
import LinkIcon from '@mui/icons-material/Link';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import type { DbmlColumn } from '../parser/model';
import type { MoveDirection } from '../edit/moveColumn';
import { ROW_HEIGHT, NOTE_LINE_HEIGHT, COLUMN_GAP, ROW_PADDING_X, noteLines } from '../layout/nodeSize';
import { ColumnEditRow, type EditRowFocusField } from './ColumnEditRow';
import { noteToInput, type ColumnInput } from '../edit/lineFormat';

// カラム行ハンドルのID(ErCanvas側のエッジ生成と対で使う)。TableNode.tsx の同名関数と同一実装
// (循環import回避のためここに複製。フォーマットが変わることはないため、乖離リスクは低い)。
function columnHandleId(columnId: string, side: 'left' | 'right'): string {
  return `${columnId}__${side}`;
}

// カラム行ハンドルの左右に置く不可視ハンドル。接続操作には使わないため pointerEvents も切る。
const columnHandleStyle = {
  opacity: 0,
  pointerEvents: 'none' as const,
};

/** FKカラム行の左右不可視ハンドル(表示行・編集行のどちらでも同じIDで出す)。 */
function ColumnRowHandles({ col }: { col: DbmlColumn }) {
  if (!col.isForeignKey) return null;
  return (
    <>
      <Handle type="source" position={Position.Left} id={columnHandleId(col.id, 'left')} style={columnHandleStyle} />
      <Handle type="target" position={Position.Left} id={columnHandleId(col.id, 'left')} style={columnHandleStyle} />
      <Handle type="source" position={Position.Right} id={columnHandleId(col.id, 'right')} style={columnHandleStyle} />
      <Handle type="target" position={Position.Right} id={columnHandleId(col.id, 'right')} style={columnHandleStyle} />
    </>
  );
}

/** 既存カラムから編集行の初期値(UI入力表記)を作る。 */
function toEditInitialValues(col: DbmlColumn): ColumnInput {
  return {
    name: col.name,
    type: col.type,
    pk: col.pk,
    notNull: col.notNull,
    defaultValue: col.dbdefault ?? '',
    note: col.note ? noteToInput(col.note) : '',
  };
}

export interface ColumnRowProps {
  col: DbmlColumn;
  idx: number;
  isLast: boolean;
  isHighlighted: boolean;
  isSelected: boolean;
  isEditingRow: boolean;
  /** isEditingRow=true のときの初期フォーカスセル(pendingEdit.focusField)。 */
  editFocusField: EditRowFocusField;
  showInsertAbove: boolean;
  showInsertBelow: boolean;
  rowGridTemplate: string;
  /** この行の高さ(rowMetrics.heights[idx])。note の行数で伸びる。 */
  rowHeight: number;
  hasNoteColumn: boolean;
  /** 並べ替え ▲▼ を出すか(フォーカス起点テーブルのみ)。 */
  reorderable: boolean;
  /** 検索ハイライトの背景色(ModeColorsContext から)。 */
  searchHighlightColor: string;
  typeOptions: string[];
  /** 挿入入力行(showInsertAbove/showInsertBelow)の描画。呼び出し元 TableNode の renderInsertRow。 */
  renderInsertRow: (rowHeight: number) => ReactNode;
  onRowClick: (e: React.MouseEvent, col: DbmlColumn) => void;
  onRowDoubleClick: (e: React.MouseEvent, col: DbmlColumn) => void;
  onRowContextMenu: (e: React.MouseEvent, col: DbmlColumn) => void;
  onRequestMove?: (col: DbmlColumn, direction: MoveDirection) => void;
  onCommitEdit?: (input: ColumnInput) => void;
  onCancelInsert?: () => void;
  isDuplicateName?: (name: string) => boolean;
  onContentWidthsChange: (widths: { name: number; type: number; note: number }) => void;
}

function ColumnRowImpl({
  col,
  idx,
  isLast,
  isHighlighted,
  isSelected,
  isEditingRow,
  editFocusField,
  showInsertAbove,
  showInsertBelow,
  rowGridTemplate,
  rowHeight,
  hasNoteColumn,
  reorderable,
  searchHighlightColor,
  typeOptions,
  renderInsertRow,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  onRequestMove,
  onCommitEdit,
  onCancelInsert,
  isDuplicateName,
  onContentWidthsChange,
}: ColumnRowProps) {
  return (
    <Box>
      {/* 追加行はまだ表示行が無いので、1行分の高さ(ROW_HEIGHT)を基準にする。 */}
      {showInsertAbove && renderInsertRow(ROW_HEIGHT)}
      {isEditingRow ? (
        // 既存カラムの編集状態: 表示行を入力行に置き換える。
        // FKハンドルはエッジ参照が切れないよう編集中も同じIDで維持する。
        <Box sx={{ position: 'relative' }}>
          <ColumnRowHandles col={col} />
          <ColumnEditRow
            typeOptions={typeOptions}
            onCommit={(input) => onCommitEdit?.(input)}
            onCancel={() => onCancelInsert?.()}
            isDuplicateName={(name) => isDuplicateName?.(name) ?? false}
            initialValues={toEditInitialValues(col)}
            autoFocusField={editFocusField}
            gridTemplate={rowGridTemplate}
            // 置き換える表示行と同じ高さにして、編集開始で行がガタつかないようにする。
            rowHeight={rowHeight}
            hasNoteColumn={hasNoteColumn}
            onContentWidthsChange={onContentWidthsChange}
          />
        </Box>
      ) : (
        <Box
          onClick={(e) => onRowClick(e, col)}
          onDoubleClick={(e) => onRowDoubleClick(e, col)}
          onContextMenu={(e) => onRowContextMenu(e, col)}
          sx={{
            // 4列グリッド(アイコン | 名前 | 型 | note)。全行同じテンプレートを使い
            // 列の左端を縦に揃える(表らしい見た目)。行単位の背景・イベントは維持。
            display: 'grid',
            gridTemplateColumns: rowGridTemplate,
            columnGap: `${COLUMN_GAP}px`,
            // カラム行ハンドルの位置基準にするため relative にする。
            position: 'relative',
            // note が複数行で行が縦に伸びたとき、アイコン・名前・型が行の中央に
            // 浮かないよう上寄せにする(2026-07-14 ユーザー要望)。1行のときの見た目を
            // 保つため、各セル側は先頭 ROW_HEIGHT の帯の中で中央に置く。
            alignItems: 'start',
            // 行高は note の行数で決まる(改行入り note の行は縦に伸びる)。
            // ノード高さ(estimateTableNodeSize)も同じ computeRowMetrics から算出するため、
            // 箱と行の合計高が一致し、行が箱(overflow:hidden)から切れることはない。
            height: rowHeight,
            // 列境界ハンドルの px 計算(ROW_PADDING_X)と揃えるため定数で指定する。
            px: `${ROW_PADDING_X}px`,
            borderBottom: '1px solid',
            borderColor: 'divider',
            // 検索ハイライト > 行選択 の優先で背景色を決める(選択は控えめに)。
            bgcolor: isHighlighted ? searchHighlightColor : isSelected ? 'action.selected' : undefined,
            '&:last-of-type': { borderBottom: 'none' },
            // 並べ替えボタンは行ホバー中だけ出す(列リサイズハンドルと同じ流儀)。
            // 非表示中は pointer-events も切る(原則6)。
            '&:hover .column-move-buttons': { opacity: 1, pointerEvents: 'auto' },
          }}
        >
          {reorderable && (
            <Stack
              direction="row"
              // nodrag/nopan: React Flow のノードドラッグ・パンに吸われないようにする。
              className="column-move-buttons nodrag nopan"
              sx={{
                position: 'absolute',
                right: `${ROW_PADDING_X}px`,
                // note が複数行で行が伸びても、ボタンは先頭 ROW_HEIGHT の帯に留める
                // (名前・型と同じ高さに見せる)。
                top: 0,
                height: `${ROW_HEIGHT}px`,
                alignItems: 'center',
                opacity: 0,
                // 非ホバー中は見えないだけでなくクリックも奪わない(原則6。
                // 行ホバーで opacity とともに解除される)。
                pointerEvents: 'none',
                transition: 'opacity 120ms',
                // 下の note テキストに重なっても読めるよう、行の背景色で敷く。
                bgcolor: isHighlighted ? searchHighlightColor : isSelected ? 'action.selected' : 'background.paper',
                borderRadius: 1,
                boxShadow: 1,
              }}
            >
              {(['up', 'down'] as const).map((direction) => {
                // 端では押せない(先頭の▲ / 末尾の▼)。
                const disabled = direction === 'up' ? idx === 0 : isLast;
                return (
                  <IconButton
                    key={direction}
                    size="small"
                    disabled={disabled}
                    aria-label={direction === 'up' ? 'カラムを上へ移動' : 'カラムを下へ移動'}
                    title={direction === 'up' ? '上へ移動' : '下へ移動'}
                    // 行の click(行選択)/dblclick(編集開始)/contextmenu を誘発させない。
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestMove?.(col, direction);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.stopPropagation()}
                    sx={{ p: '2px' }}
                  >
                    {direction === 'up' ? (
                      <ArrowUpwardIcon sx={{ fontSize: 14 }} />
                    ) : (
                      <ArrowDownwardIcon sx={{ fontSize: 14 }} />
                    )}
                  </IconButton>
                );
              })}
            </Stack>
          )}
          {/* Refに登場するカラムのみ、行の左右に不可視ハンドルを置き、
              リレーション線をカラム位置から出す。source/target のどちらでも
              使えるよう両タイプを同じIDで重ねる(React Flow はタイプ別に解決する)。
              position:absolute のハンドルはグリッドの列消費をしない。 */}
          <ColumnRowHandles col={col} />
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              height: `${ROW_HEIGHT}px`,
            }}
            title={col.pk ? '主キー (PK)' : col.isForeignKey ? '外部キー (FK)' : undefined}
          >
            {col.pk ? (
              <KeyIcon sx={{ fontSize: 14, color: 'warning.light' }} />
            ) : col.isForeignKey ? (
              <LinkIcon sx={{ fontSize: 14, color: 'info.light' }} />
            ) : null}
          </Box>
          {/* 行が note で縦に伸びても先頭 ROW_HEIGHT の帯に留めるため行高をpx固定する
              (display:flex にすると noWrap の省略記号が効かなくなるため lineHeight で揃える)。 */}
          <Typography data-cell="name" variant="body2" noWrap sx={{ minWidth: 0, lineHeight: `${ROW_HEIGHT}px` }} title={col.name}>
            {col.name}
          </Typography>
          <Typography
            data-cell="type"
            variant="caption"
            noWrap
            sx={{ color: 'text.secondary', minWidth: 0, lineHeight: `${ROW_HEIGHT}px` }}
            title={col.type}
          >
            {col.type}
          </Typography>
          {hasNoteColumn && (
            // note は改行(\n)の数だけ複数行で表示する。自動折り返しはしない
            // (折り返すと実描画の行数が概算とズレて行が切れるため。2026-07-14 ユーザー決定)。
            // 列幅に収まらない行は従来どおり1行ずつ省略する。
            <Typography
              data-cell="note"
              variant="caption"
              component="div"
              sx={{
                color: 'text.primary',
                minWidth: 0,
                // 1行目を名前・型と同じ高さに揃える(行は上寄せなので、
                // ROW_HEIGHT の帯に1行を中央配置したときの上余白を自前で持つ)。
                pt: `${(ROW_HEIGHT - NOTE_LINE_HEIGHT) / 2}px`,
              }}
            >
              {col.note
                ? noteLines(col.note).map((line, lineIdx) => (
                    <Box
                      key={lineIdx}
                      sx={{
                        // 高さ概算(NOTE_LINE_HEIGHT)と一致させるため行高をpx固定する。
                        lineHeight: `${NOTE_LINE_HEIGHT}px`,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        // 列幅オートフィットは data-cell="note" 配下を Range で実測する。
                        // 行を幅いっぱいのblockにすると実測が列幅そのものになってしまうため、
                        // 内容幅にフィットさせる(超過分は maxWidth で抑えて省略する)。
                        width: 'fit-content',
                        maxWidth: '100%',
                      }}
                    >
                      {/* 空行(連続する改行)でも行の高さを保つ。 */}
                      {line || ' '}
                    </Box>
                  ))
                : null}
            </Typography>
          )}
        </Box>
      )}
      {showInsertBelow && renderInsertRow(ROW_HEIGHT)}
    </Box>
  );
}

// 大規模テーブル(カラム数が多い)でも、無関係な行の再レンダーを避けるため memo 化する。
// renderInsertRow は TableNode 側で毎レンダー再生成される関数のため、挿入行が開いている行では
// 常に再レンダーされるが、それ以外の大多数の行では props が安定し memo が効く。
export const ColumnRow = memo(ColumnRowImpl);
