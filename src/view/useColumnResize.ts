// 列境界リサイズ/オートフィットのドラッグ処理。TableNode から抽出。
// - makeColumnResizeMouseDown: Excel風の列境界ドラッグ。境界を掴むと「境界の左側の列」の
//   右端を伸縮する(ズーム率補正込み mousedown/mousemove/mouseup)。
// - makeColumnAutoFit: 列境界のダブルクリックで、その列を Range 実測した内容幅にフィットさせる。
// rootRef はどちらの処理もズーム率補正(getBoundingClientRect/offsetWidth の比較)に使うため、
// このフックが所有し、呼び出し側(TableNode)は返り値をルート要素の ref にそのまま渡す。
// resizingCols(ドラッグ中のプレビュー列幅)の state 自体は呼び出し側が持ち続け、setter だけを渡す
// (columnWidths の算出が resizingCols に依存しており、呼び出し側で他の値ともまとめて使うため)。
import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ColumnWidthOverride, TableColumnWidths } from '../layout/nodeSize';

type ResizeField = 'name' | 'type' | 'note';

const COLUMN_MIN_WIDTH = 24;

export interface UseColumnResizeParams {
  tableId: string;
  /** ドラッグ開始時点の基準幅(保存済み override・自動概算を反映済みの実効値)。 */
  columnWidths: TableColumnWidths;
  /**
   * カラム列幅(名前/型/note)の手動リサイズ確定(境界ハンドルを離したとき)。newWidth は px。
   */
  onResizeColumn?: (tableId: string, field: ResizeField, newWidth: number) => void;
  /**
   * 列境界のダブルクリックで、その列を実測した内容幅にフィットさせる(Excelのオートフィット)。
   */
  onAutoFitColumn?: (tableId: string, field: ResizeField, measuredWidth: number) => void;
  /** ドラッグ中だけ入るローカル列幅プレビュー。呼び出し側の state をそのまま更新する。 */
  setResizingCols: Dispatch<SetStateAction<ColumnWidthOverride | null>>;
}

export function useColumnResize({
  tableId,
  columnWidths,
  onResizeColumn,
  onAutoFitColumn,
  setResizingCols,
}: UseColumnResizeParams) {
  // rootRef: 列境界ドラッグのズーム率補正(getBoundingClientRect/offsetWidth の比較)に使う。
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 列境界ドラッグ(Excel風): 境界を掴むと「境界の左側の列」の右端を伸縮する。
  // - 名前↔型 境界 → 左列=名前列(field='name')
  // - 型↔note 境界(またはnote無しなら型列右端) → 左列=型列(field='type')
  // - note右端 → 左列=note列(field='note')
  // 左列の右端を右へ動かす(deltaX>0)ほど列は広がるので符号は「プラス」。右側の列は位置が
  // ずれるだけ(テーブル外形はノード幅の再計算で追従して広がる)。ドラッグ中は resizingCols で
  // グリッドテンプレートだけ変えてプレビューし(React Flow の nodes は触らない)、離した瞬間に
  // onResizeColumn を1回だけ呼んで確定する。開始幅はその時点の columnWidths(保存/自動)。
  const makeColumnResizeMouseDown = useCallback(
    (field: ResizeField) => (e: React.MouseEvent) => {
      if (e.button !== 0 || !onResizeColumn) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      // ズーム率補正(テーブル幅リサイズと同じ考え方)。rootRef の見かけ幅/論理幅で率を出す。
      const rectW = rootRef.current?.getBoundingClientRect().width ?? 1;
      const offW = rootRef.current?.offsetWidth || rectW;
      const zoom = offW > 0 ? rectW / offW : 1;
      const startWidth = columnWidths[field];
      const clamp = (w: number) => Math.max(COLUMN_MIN_WIDTH, Math.round(w));

      let latest = clamp(startWidth);
      // mousemove が一度も来ていない(単クリックやダブルクリックの先行 mousedown/up)場合は
      // 確定を呼ばない。幅が変わっていないのに applyColumnWidths→サイドカー保存まで走るのを防ぐ。
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        const deltaLogical = (ev.clientX - startX) / (zoom || 1);
        // 左列の右端を掴んでいるので、右へ動かす(deltaLogical>0)ほど列は広がる。
        latest = clamp(startWidth + deltaLogical);
        moved = true;
        setResizingCols((prev) => ({ ...prev, [field]: latest }));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        setResizingCols(null); // プレビュー解除(確定値は親=columnWidthOverride 経由で反映)
        // 実際にドラッグして幅が変わったときだけ確定通知する。
        if (moved && latest !== clamp(startWidth)) {
          onResizeColumn(tableId, field, latest);
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [onResizeColumn, columnWidths, tableId, setResizingCols],
  );

  // 列境界のダブルクリック(Excelのオートフィット): 境界の左列を、実測したその列の
  // 最大内容幅に合わせた幅へ変更する(補正1: scrollWidthではなくRangeによるテキスト実測)。
  const makeColumnAutoFit = useCallback(
    (field: ResizeField) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onAutoFitColumn) return;
      const root = rootRef.current;
      if (!root) return;
      // ズーム率補正: 列ドラッグと同じ考え方で、見かけ幅/論理幅の比から求める。
      const rectW = root.getBoundingClientRect().width;
      const offW = root.offsetWidth || rectW || 1;
      const zoom = offW > 0 ? rectW / offW : 1;

      const cells = root.querySelectorAll<HTMLElement>(`[data-cell="${field}"]`);
      let maxWidth = 0;
      cells.forEach((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const w = range.getBoundingClientRect().width;
        if (w > maxWidth) maxWidth = w;
      });
      // 見かけ幅→論理px(ズーム率で割り戻す)。バッファを足して切り上げ、下限でクランプする。
      const logicalWidth = (maxWidth / (zoom || 1)) + 4;
      const measured = Math.max(COLUMN_MIN_WIDTH, Math.ceil(logicalWidth));
      onAutoFitColumn(tableId, field, measured);
    },
    [onAutoFitColumn, tableId],
  );

  return { rootRef, makeColumnResizeMouseDown, makeColumnAutoFit };
}
