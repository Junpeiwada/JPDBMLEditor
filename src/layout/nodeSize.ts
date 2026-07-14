// テーブルノードのサイズ計算。
// React Flow のノード実測(レイアウト後にDOMサイズを取得して再レイアウト)は複雑になるため、
// レイアウト前にテキスト幅から自前計算する。カラム行の各列(名前/型/note)の幅は
// canvas measureText による実フォント実測(2026-07-14 移行)。文字数×固定係数の概算
// (estimateTextWidth)は、大文字英字などで実描画より狭く出て表示の「…」省略・編集欄の
// 見切れを生んでいたため、列幅には使わない(ヘッダー・LOD用に概算も残す)。
//
// カラム行は「アイコン | カラム名 | 型 | note」の4列グリッド(TableNode側)で縦に整列させる。
// 型列・note列の幅はテーブル内の全カラムの最大値で決まるため、ここで一括計算して
// TableNode(グリッドテンプレート)とノード幅概算の両方が同じ値を使う。
import type { DbmlTable } from '../parser/model';

const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 26; // note が1行(または無し)のときの行高
const NOTE_LINE_HEIGHT = 16; // カラムnoteの2行目以降の1行あたり高さ(TableNode側のlineHeightと揃える)
const CHAR_WIDTH = 7; // 半角1文字あたりの概算px(MUI body2相当)
// estimateTextWidth の基準フォントサイズ(px)。TableNode本体の実描画フォント(fontSize:13)と
// 暗黙に一致させている値のため、両所から参照できるよう明示的に export する。
export const BASE_FONT_SIZE = 13;
// 本体エリア下端の余白(px)。ノード高さ算出(estimateTableNodeSize)とLODフォント計算
// (TableNode の bodyFontSize/computeCollapsedFontSize)で一致させること。
export const BODY_BOTTOM_PADDING = 8;
const MIN_WIDTH = 180;
const NOTE_MAX_WIDTH = 180; // カラムnoteの表示上限幅
const ICON_COL_WIDTH = 16; // PK/FKアイコン列
// 名前列・型列の最小幅。カラム名が短いテーブルでも、その場編集(ColumnEditRow は表示行と同じ
// 列テンプレートに入力欄を重ねる)で入力欄が潰れないだけの幅を必ず確保する。表示・編集・ノード幅
// 概算はすべて computeColumnWidths を通るため、この下限は3者で共有される。
// 概算幅(CHAR_WIDTH=7)は実描画よりやや狭く、短い名前が表示側でも省略される問題も緩和される。
const MIN_NAME_COL_WIDTH = 80;
const MIN_TYPE_COL_WIDTH = 56;
// note列の最小幅(note列が存在するテーブルにのみ効く。note が無ければ列ごと省略のまま)。
const MIN_NOTE_COL_WIDTH = 56;
// 並べ替え ▲▼ 用の右ガター幅(ボタン実測36px + 右余白8px)。フォーカス起点テーブルのみ、
// 箱幅にこの分を足して行の右端に専用領域を作る(▲▼ が note セルを覆ってダブルクリック編集を
// 奪わないようにする。Docs/設計-行オーバレイ.md 案2)。レイアウト状態(layoutNodes)には入れず、
// ErCanvas の最終ノード派生と TableNode の previewWidth だけがこの定数を加算する。
export const MOVE_GUTTER_WIDTH = 44;
const COLUMN_GAP = 6; // グリッド列間ギャップ(TableNode側の columnGap と揃える)
const ROW_PADDING_X = 8; // 行の片側パディング(TableNode側の px:1 = 8px と揃える)
const ROW_H_PADDING = ROW_PADDING_X * 2; // 行の左右パディング合計

/**
 * note を表示行に分割する。
 *
 * 重要: `@dbml/core` は note 内の `\n` をエスケープとして解釈せず、バックスラッシュ+n の
 * 2文字のまま内部モデルに入れる(SampleDBML の実データで確認済み)。そのため内部モデルの note の
 * 「改行」はリテラル `\n` として現れる。実改行も念のため区切りとして扱う。
 *
 * 行数がそのまま行高になるため、TableNode の note セルは必ずこの関数で分割すること
 * (描画側と分割規則がズレると箱から行がはみ出す)。自動折り返しはしない方針
 * (2026-07-14 ユーザー決定)なので行数は決定的に決まり、概算と実描画がズレない。
 */
export function noteLines(note: string): string[] {
  return note.split(/\\n|\r\n|\r|\n/);
}

// --- セルテキストの実測 ---------------------------------------------------
// 列幅は canvas measureText で実フォントの実幅を測って決める。フォント指定は
// TableNode の実描画(MUI Typography)と一致させること:
//   名前セル = body2(14px)、型/note セル = caption(12px)。
// canvas は letter-spacing を測れないため、MUI テーマの letterSpacing を文字数分加算する。
const FONT_STACK = 'Roboto, Helvetica, Arial, sans-serif'; // MUI 既定と同一(未ロード時のフォールバックも実描画と同じ挙動になる)
const NAME_FONT = `400 14px ${FONT_STACK}`; // MUI body2
const NAME_LETTER_SPACING = 0.15; // body2: 0.01071em × 14px
const CELL_FONT = `400 12px ${FONT_STACK}`; // MUI caption
const CELL_LETTER_SPACING = 0.4; // caption: 0.03333em × 12px
// 実測値に足す安全余白(px)。サブピクセル丸めで表示の省略記号が出たり、編集欄(パディング0)で
// 字面が枠に密着したりしないための最小限。
const CELL_MEASURE_BUFFER = 2;

// undefined=未初期化 / null=canvas が使えない環境(Node の verify スクリプト等)。
let measureCtx: CanvasRenderingContext2D | null | undefined;
const measureCache = new Map<string, number>();

/**
 * テキストの実描画幅(px)を canvas で実測する(letterSpacing 加算込み)。
 * canvas が無い環境では null を返し、呼び出し側が estimateTextWidth へフォールバックする。
 * 同一テキストの再計測を避けるためキャッシュする(キーはフォント+テキスト)。
 */
function measureTextWidth(text: string, font: string, letterSpacing: number): number | null {
  if (measureCtx === undefined) {
    measureCtx =
      typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (!measureCtx) return null;
  const key = `${font}|${text}`;
  let width = measureCache.get(key);
  if (width === undefined) {
    measureCtx.font = font;
    width = measureCtx.measureText(text).width;
    measureCache.set(key, width);
  }
  return width + letterSpacing * text.length;
}

/** セル種別ごとの実測幅。canvas 非対応環境では従来の文字数概算にフォールバックする。 */
function cellTextWidth(text: string, kind: 'name' | 'cell'): number {
  const measured =
    kind === 'name'
      ? measureTextWidth(text, NAME_FONT, NAME_LETTER_SPACING)
      : measureTextWidth(text, CELL_FONT, CELL_LETTER_SPACING);
  return measured ?? estimateTextWidth(text);
}

/**
 * 編集中の入力内容がセルに収まるために必要な列幅(px)を返す(安全余白込み)。
 * インライン編集の「切れないこと最優先」(2026-07-14 ユーザー決定)のため、TableNode は
 * この値が現在の列幅を超えたら列ごとライブで広げる(Docs/設計-行オーバレイ.md)。
 * kind は cellTextWidth と同じ(name=body2 14px / cell=caption 12px)。
 */
export function editContentColumnWidth(text: string, kind: 'name' | 'cell'): number {
  return Math.ceil(cellTextWidth(text, kind)) + CELL_MEASURE_BUFFER;
}

/**
 * 文字列の表示幅を概算する(全角2文字幅、半角1文字幅、基準13px)。
 * 列幅には使わない(実測 cellTextWidth に移行済み)。ヘッダー幅と LOD の表名フォント
 * フィット(いずれも余白/安全係数を持つ用途)、および canvas 非対応環境のフォールバック用。
 */
export function estimateTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // 大まかに全角範囲(ひらがな/カタカナ/漢字/全角記号など)を判定
    const isFullWidth =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += isFullWidth ? 2 : 1;
  }
  return width * CHAR_WIDTH;
}

/** カラム行グリッドの列幅(テーブル内最大値ベース)。 */
export interface TableColumnWidths {
  /** 名前列の幅(px)。Excel風リサイズのため名前列も絶対px幅を持つ。 */
  name: number;
  /** 型列の幅(px)。 */
  type: number;
  /** note列の幅(px)。テーブル内にnoteが1つも無ければ 0(列ごと省略)。 */
  note: number;
}

/** 手動リサイズした列幅の上書き(px)。未指定の列は自動概算に委ねる。 */
export interface ColumnWidthOverride {
  name?: number;
  type?: number;
  note?: number;
}

/**
 * テーブル内の全カラムから名前列・型列・note列の幅を計算する。
 * 全行で同じ幅を使うことで列の左端が縦に揃う。Excel風の列リサイズに合わせ、名前列も
 * 絶対px幅を持つ(自動時はテーブル内の最大名前幅)。
 *
 * override が渡され、その列に有効な手動幅があればそれを優先する(あれば使う=設計原則3)。
 * ただし note 列は、テーブル内に note が1つも無ければ 0(列ごと省略)を維持する
 * (存在しない列を手動幅で復活させない)。
 *
 * 自動算出時は MIN_*_COL_WIDTH を下限とする(短いカラム名ばかりのテーブルでも、その場編集の
 * 入力欄が潰れない幅を確保する)。手動幅は下限でクランプしない: ユーザーが列境界を掴んで
 * 明示的に狭めた結果は尊重する(狭めたのに跳ね返るとリサイズ不能に見えるため)。
 */
export function computeColumnWidths(table: DbmlTable, override?: ColumnWidthOverride): TableColumnWidths {
  let nameWidth = 0;
  let typeWidth = 0;
  let noteWidth = 0;
  let hasNote = false;
  for (const col of table.columns) {
    nameWidth = Math.max(nameWidth, cellTextWidth(col.name, 'name'));
    typeWidth = Math.max(typeWidth, cellTextWidth(col.type, 'cell'));
    if (col.note) {
      hasNote = true;
      // note は複数行表示(改行のみ・折り返しなし)なので、全行のうち最長の行に幅を合わせる。
      for (const line of noteLines(col.note)) {
        noteWidth = Math.max(noteWidth, Math.min(NOTE_MAX_WIDTH, cellTextWidth(line, 'cell')));
      }
    }
  }
  const name =
    override?.name != null && override.name > 0
      ? Math.ceil(override.name)
      : Math.max(MIN_NAME_COL_WIDTH, Math.ceil(nameWidth) + CELL_MEASURE_BUFFER);
  const type =
    override?.type != null && override.type > 0
      ? Math.ceil(override.type)
      : Math.max(MIN_TYPE_COL_WIDTH, Math.ceil(typeWidth) + CELL_MEASURE_BUFFER);
  // note 列は存在するテーブルでのみ手動幅を採用する(note が無いテーブルは 0=列非表示のまま)。
  const note = hasNote
    ? override?.note != null && override.note > 0
      ? Math.ceil(override.note)
      : Math.max(MIN_NOTE_COL_WIDTH, Math.min(NOTE_MAX_WIDTH, Math.ceil(noteWidth) + CELL_MEASURE_BUFFER))
    : 0;
  return { name, type, note };
}

/** テーブルのカラム行ごとの高さ(px)と、その積み上げ位置。 */
export interface TableRowMetrics {
  /** 各カラム行の高さ(px)。table.columns と同じ順序・同じ長さ。 */
  heights: number[];
  /** 各カラム行の上端Y(本体エリア先頭=0からの相対px)。heights の排他的累積和。 */
  offsets: number[];
  /** 全カラム行の合計高さ(px)。カラムが0本なら1行分(ROW_HEIGHT)。 */
  total: number;
}

/**
 * カラム行の高さを行ごとに計算する。note が複数行(改行入り)のカラムはその分だけ縦に伸びる。
 * 行高は「note の行数」だけで決まり、自動折り返しはしないため、ここでの計算と実描画は必ず一致する
 * (ノードの箱は overflow:hidden のため、低く見積もると行が切れる。これを構造的に防ぐ)。
 *
 * TableNode(各行の height / ハンドル位置)と estimateTableNodeSize(ノード高さ)の両方が
 * この単一の関数を使うことで、箱と中身がズレない。
 */
export function computeRowMetrics(table: DbmlTable): TableRowMetrics {
  const heights: number[] = [];
  const offsets: number[] = [];
  let acc = 0;
  for (const col of table.columns) {
    const lines = col.note ? noteLines(col.note).length : 1;
    const height = ROW_HEIGHT + Math.max(0, lines - 1) * NOTE_LINE_HEIGHT;
    offsets.push(acc);
    heights.push(height);
    acc += height;
  }
  // カラムが1本も無いテーブルでも本体エリアの高さが0にならないようにする(従来挙動の維持)。
  return { heights, offsets, total: table.columns.length === 0 ? ROW_HEIGHT : acc };
}

export interface EstimatedSize {
  width: number;
  height: number;
}

/**
 * テーブルのカラム数・各列(名前/型/note)の最大文字幅からノードサイズを概算する。
 * override(手動列幅)があれば列幅にそれを反映し、ノード幅も追従して広がる。
 */
export function estimateTableNodeSize(table: DbmlTable, override?: ColumnWidthOverride): EstimatedSize {
  // カラム行: 4列グリッド(アイコン | 名前 | 型 | note)の各列幅(override反映済み)の合計。
  const { name: nameWidth, type: typeWidth, note: noteWidth } = computeColumnWidths(table, override);
  const gapCount = noteWidth > 0 ? 3 : 2;
  const contentWidth =
    ICON_COL_WIDTH + nameWidth + typeWidth + noteWidth + gapCount * COLUMN_GAP + ROW_H_PADDING;

  // 箱幅の上限クランプは行わない(2026-07-14 廃止)。全列固定pxグリッド(TableNode の
  // rowGridTemplate)は列幅合計をそのまま敷くため、箱だけをクランプすると列が箱
  // (overflow:hidden)からはみ出し、右端の列とリサイズハンドルに届かなくなる。
  // 横に伸びすぎる主因のカラム note は NOTE_MAX_WIDTH で列側に上限があるため実害は小さい。
  // ヘッダー(テーブル名+日本語note)は幅決定に関与させない(2026-07-15 ユーザー決定)。
  // 箱幅はカラム内容のみで決め、収まらないヘッダーは TableNode 側で「…」省略する
  // (全文はツールチップで見せる)。長い表名で箱だけが横に伸びるのを防ぐ。
  const width = Math.max(MIN_WIDTH, contentWidth + BODY_BOTTOM_PADDING);
  // カラム数と各行の高さ(複数行noteの分だけ伸びる)に応じてノードを縦に伸ばし、
  // 全カラムを表示する(頭打ちなし)。
  const height = HEADER_HEIGHT + computeRowMetrics(table).total + BODY_BOTTOM_PADDING;

  return { width, height };
}

/**
 * LOD(縮小表示)時、本体エリアに収まる範囲でテーブル名を最大化するフォントサイズ(px)を概算する。
 * 最優先は「表名が省略されず必ず箱の幅に収まる」こと(遠目で表名が読めるのが目的。
 * 2026-07-14 ユーザー決定: 縮小時はヘッダー + 大きな表名のみ)。
 * TableNode の bodyFontSize useMemo から呼ばれる純粋計算(collapsed=false時は呼ばない)。
 */
export function computeCollapsedFontSize(table: DbmlTable, override?: ColumnWidthOverride): number {
  const size = estimateTableNodeSize(table, override);
  const bodyH = size.height - HEADER_HEIGHT - BODY_BOTTOM_PADDING; // 本体エリア(ヘッダー・余白を除く)の高さ
  const bodyW = size.width - 16; // 左右パディング分を引く
  // estimateTextWidth は基準フォント(CHAR_WIDTH=7px ≒ fontSize BASE_FONT_SIZE px)での表示幅px。
  // よって fontSize f のときの実表示幅 ≒ textWidth * (f/BASE_FONT_SIZE)。これを bodyW 以下にする
  // 最大の f は f = bodyW / textWidth * BASE_FONT_SIZE
  // ただし太字(700)は基準より横に太いので安全係数 0.72 を掛け、省略が出ないようにする
  // (幅ぴったりだと窮屈に見えるため、左右に少し余白を残す。2026-07-14 ユーザー要望)。
  // 高さは上限としてのみ効かせる(本体高の 0.9)。下限は設けない(狭い箱では小さくてよい)。
  const textWidth = estimateTextWidth(table.name) || 1;
  const byWidth = (bodyW / textWidth) * BASE_FONT_SIZE * 0.72;
  // note(日本語テーブル名)を下に併記する場合は、その分の高さを譲る。
  const byHeight = bodyH * (table.note ? 0.6 : 0.9);
  // 下限 14px は「遠目でも読める最小」の確保。ここに達して幅を超える長い名前は
  // Typography 側の折り返し(overflowWrap:anywhere)で2行以上にして全文見せる。
  return Math.max(14, Math.min(120, Math.floor(Math.min(byWidth, byHeight))));
}

// テーブル幅の最小フォールバック値(自動概算の下限 MIN_WIDTH と揃える)。箱の直接リサイズは
// 廃止したが、押し出し判定(resolveOverlapToRight)用の矩形を組む際、measured/style.width が
// まだ無いノードの暫定幅として使う。
export const MIN_TABLE_WIDTH = MIN_WIDTH;

export { ROW_HEIGHT, NOTE_LINE_HEIGHT, HEADER_HEIGHT, ICON_COL_WIDTH, NOTE_MAX_WIDTH, COLUMN_GAP, ROW_PADDING_X };
