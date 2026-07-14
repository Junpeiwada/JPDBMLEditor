// 列境界リサイズハンドル(Excel風)。TableNode から抽出。
// 「境界の左側の列」を伸縮する。全列が固定pxのため、位置は left 基準(行の左端からの積み上げ)
// で計算する(補正3)。right 基準だと、ヘッダー幅が列合計より広いテーブルで列が左詰めのまま
// 右に余白ができ、位置がずれるため。
// - 名前列右端 → 左列=名前列(field='name')
// - 型列右端(note列があれば名前↔note間の境界、無ければ最右列の右端そのもの)
//   → 左列=型列(field='type')
// - note列右端(note列があるときのみ、最右列の右端) → 左列=note列(field='note')
// ダブルクリックでその列を実測フィット(Range計測。呼び出し元 TableNode の makeColumnAutoFit)。
// LOD中・編集行表示中は呼び出し元がそもそもレンダーしない。ドラッグ中は resizingCols 込みの
// columnWidths(プレビュー値)で追従するため、確定前でもハンドル位置が動いた列に付いてくる。
import { Box } from '@mui/material';
import type { MouseEventHandler } from 'react';
import { HEADER_HEIGHT, ICON_COL_WIDTH, COLUMN_GAP, ROW_PADDING_X, type TableColumnWidths } from '../layout/nodeSize';

type ResizeField = 'name' | 'type' | 'note';

export interface ColumnResizeHandlesProps {
  /** 現在の列幅(ドラッグ中はプレビュー値込みの実効値)。 */
  columnWidths: TableColumnWidths;
  /** 本体エリアの高さ(ハンドルの縦幅)。 */
  bodyHeight: number;
  /** 境界ドラッグ開始(mousedown)ハンドラを field ごとに生成する。 */
  onMouseDown: (field: ResizeField) => MouseEventHandler;
  /** 境界ダブルクリック(オートフィット)ハンドラを field ごとに生成する。 */
  onAutoFit: (field: ResizeField) => MouseEventHandler;
}

export function ColumnResizeHandles({ columnWidths, bodyHeight, onMouseDown, onAutoFit }: ColumnResizeHandlesProps) {
  const ROW_PAD = ROW_PADDING_X; // 行の片側パディング(px:1)。nodeSize と単一定数で共有。
  const halfGap = COLUMN_GAP / 2;
  // 左端から見た各境界の位置(ギャップ中央、ただし最右列の右端はギャップを足さない)。
  const nameRight = ROW_PAD + ICON_COL_WIDTH + COLUMN_GAP + columnWidths.name;
  const typeRight = nameRight + COLUMN_GAP + columnWidths.type;
  const hasNote = columnWidths.note > 0;
  const nameBoundaryLeft = nameRight + halfGap; // 名前列右端(常にギャップの中央)
  // 型列右端: noteがあれば次の境界(ギャップ中央)、無ければ最右列なので列右端そのもの。
  const typeBoundaryLeft = hasNote ? typeRight + halfGap : typeRight;
  // note列右端: 最右列の右端そのもの(noteがある場合のみ描画)。
  const noteBoundaryLeft = typeRight + COLUMN_GAP + columnWidths.note;
  const handleSx = (leftPx: number) => ({
    position: 'absolute' as const,
    top: HEADER_HEIGHT,
    left: leftPx,
    width: 7,
    height: bodyHeight,
    transform: 'translateX(-50%)', // left 基準の位置を境界中心に合わせる
    cursor: 'col-resize',
    zIndex: 2,
    opacity: 0,
    // 非表示中はクリックも奪わない(ノードホバーで opacity とともに解除される。原則6)。
    pointerEvents: 'none' as const,
    transition: 'opacity 0.12s ease',
    // ホバー時の縦線は borderLeft だと箱(幅7px)の左辺=境界中心の3.5px左に描かれて
    // ずれるため、gradient で箱の中央2pxだけを塗って境界中心に重ねる。
    color: 'primary.light',
    background: `linear-gradient(to right,
      transparent calc(50% - 1px),
      currentColor calc(50% - 1px),
      currentColor calc(50% + 1px),
      transparent calc(50% + 1px))`,
  });
  return (
    <>
      {/* 名前列右端 → 名前列を伸縮 */}
      <Box
        className="column-resize-handle nodrag nopan"
        onMouseDown={onMouseDown('name')}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onAutoFit('name')}
        sx={handleSx(nameBoundaryLeft)}
      />
      {/* 型列右端 → 型列を伸縮(note の有無に関わらず常に描画=決定事項「全列対象」) */}
      <Box
        className="column-resize-handle nodrag nopan"
        onMouseDown={onMouseDown('type')}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onAutoFit('type')}
        sx={handleSx(typeBoundaryLeft)}
      />
      {/* note列右端 → note列を伸縮(note列が存在するときのみ) */}
      {hasNote && (
        <Box
          className="column-resize-handle nodrag nopan"
          onMouseDown={onMouseDown('note')}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={onAutoFit('note')}
          sx={handleSx(noteBoundaryLeft)}
        />
      )}
    </>
  );
}
