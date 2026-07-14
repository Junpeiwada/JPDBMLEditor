// 最小編集ロジック(純関数)。DBML全体を逆生成せず、テーブル定義ブロック内の
// 指定位置に1行だけを差し込む。
//
// 位置の考え方(Docs/spike-位置情報.md の実データ確認結果に基づく):
// - @dbml/core の field.token は「そのフィールドの開始行」〜「次フィールドの開始行
//   (最後のフィールドの場合は次の非フィールド行、通常は空行)」を指す。
// - そのため「カラムXの上に挿入」は token.start.line の位置に、
//   「カラムXの下に挿入」は token.end.line の位置に新しい行を差し込めば、
//   隣接カラムやテーブル末尾の `Note: '...'` 行・`}` を一切壊さずに済む。
// - 「テーブル末尾に追加」は「最後のカラムの下に挿入」と同じ扱いにする
//   (token.end.line が空行/Note行/`}` のどれであっても、その直前に差し込まれるため安全)。
//
// 将来のコピペ・行並べ替え(Docs/UI設計.md E-2)を見据え、この「行番号Nの直前に1行差し込む」
// という一般化されたプリミティブ(insertLineBefore)を土台にしている。複数行の移動は
// 「切り出し(削除)」+「挿入」の組み合わせで表現できる想定(削除は行範囲の丸ごと除去、
// 挿入は本モジュールの仕組みをそのまま使える)。
//
// 既知の制限(insertColumn.verify.mts ケース6で確認): カラム定義の直前に独自コメント行
// (`// ...`)がある場合、@dbml/core 上は「前カラムのtoken.end」と「次カラムのtoken.start」が
// 両方ともそのコメント行を指す。そのため「次カラムの上に挿入」はコメント行の直前(コメントより
// さらに上)に入り、「前カラムの下に挿入」と同じ位置になる。コメント行自体は壊れないが、
// 見た目上コメントを飛び越えて挿入される。SampleDBMLの実データにはテーブルブロック内の
// 行コメントが存在しなかったため実害は未確認だが、将来そうしたデータに当たった場合は
// コメント行を検出して挿入位置を補正する改良が必要になる。
import type { DbmlColumn, DbmlTable } from '../parser/model';
import { formatColumnLine, type ColumnInput } from './lineFormat.ts';
import { splitSourceLines } from './sourceLines.ts';

export type InsertPosition = 'above' | 'below' | 'end';

export interface InsertColumnResult {
  /** 差し込み後の全文。 */
  newText: string;
  /** 実際に挿入された行の内容(インデント込み)。 */
  insertedLine: string;
  /** 挿入された行番号(1始まり、newText上の行番号)。 */
  insertedLineNumber: number;
}

/** 行配列の該当行からインデント(先頭の空白/タブ)を抽出する。 */
function extractIndent(line: string | undefined): string {
  if (!line) return '  ';
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : '  ';
}

/**
 * 挿入位置解決の基準となる「対象カラム」を決定する(resolveInsertLineNumber /
 * resolveIndentSourceLine 共通)。
 * - 'end' または anchorColumn が null の場合: テーブル最後のカラム
 *   (カラムが1つも無いテーブルでは null。DBML構文上は本来起こり得ないが防御的に対応)。
 * - それ以外: anchorColumn 自身。
 */
function resolveTargetColumn(
  table: DbmlTable,
  anchorColumn: DbmlColumn | null,
  position: InsertPosition,
): DbmlColumn | null {
  if (position === 'end' || anchorColumn === null) {
    return table.columns[table.columns.length - 1] ?? null;
  }
  return anchorColumn;
}

/**
 * 挿入位置(1始まり行番号)を決定する。
 * - anchorColumn が null の場合は 'end' 扱い(テーブル末尾、実質は最後のカラムの下)。
 * - 'above': anchorColumn.token.start.line の直前(=その行番号の位置に新しい行を割り込ませる)。
 * - 'below' / 'end': anchorColumn.token.end.line の位置に割り込ませる
 *   (token.end.line は次カラムの開始行、または最後のカラムなら後続の空行/Note行/`}` の行)。
 * - テーブルにカラムが1つも無い場合(DBML構文上は本来起こり得ないが防御的に対応):
 *   テーブルブロックの閉じ`}`の行(table.token.end.line)の直前に挿入する。
 */
function resolveInsertLineNumber(
  table: DbmlTable,
  anchorColumn: DbmlColumn | null,
  position: InsertPosition,
): number | undefined {
  const isEndLike = position === 'end' || anchorColumn === null;
  const target = resolveTargetColumn(table, anchorColumn, position);
  if (!target) {
    return table.token?.end.line;
  }
  if (!target.token) return undefined;
  if (!isEndLike && position === 'above') {
    return target.token.start.line;
  }
  return target.token.end.line;
}

/** インデント抽出の参照行(挿入位置の隣接カラム行)を決める。 */
function resolveIndentSourceLine(
  lines: string[],
  table: DbmlTable,
  anchorColumn: DbmlColumn | null,
  position: InsertPosition,
): string | undefined {
  const target = resolveTargetColumn(table, anchorColumn, position);
  if (!target) {
    // カラムが1つも無いテーブル: 参照できる既存カラム行が無いため、
    // extractIndent のデフォルト(2スペース)にフォールバックさせる。
    return undefined;
  }
  if (!target.token) return undefined;
  return lines[target.token.start.line - 1];
}

/**
 * テーブル定義ブロックの指定位置に、新しいカラム定義を1行だけ差し込む。
 *
 * @param sourceText 現在のDBML全文
 * @param table 対象テーブル(パース済みモデル。token情報が必須)
 * @param anchorColumn 基準となるカラム(null なら 'end' として扱う=テーブル末尾)
 * @param position 'above' | 'below' | 'end'
 * @param newColumnDef 挿入する新カラムの入力値
 */
export function insertColumnLine(
  sourceText: string,
  table: DbmlTable,
  anchorColumn: DbmlColumn | null,
  position: InsertPosition,
  newColumnDef: ColumnInput,
): InsertColumnResult {
  if (!table.token) {
    throw new Error(`テーブル "${table.name}" の位置情報が取得できません(token未取得)。`);
  }

  const { eol, lines } = splitSourceLines(sourceText);

  const insertLineNumber = resolveInsertLineNumber(table, anchorColumn, position);
  if (insertLineNumber === undefined) {
    throw new Error(
      anchorColumn
        ? `カラム "${anchorColumn.name}" の位置情報が取得できません(token未取得)。`
        : `テーブル "${table.name}" にカラムが無いため末尾挿入位置を特定できません。`,
    );
  }

  const indentSourceLine = resolveIndentSourceLine(lines, table, anchorColumn, position);
  const indent = extractIndent(indentSourceLine);
  const insertedLine = `${indent}${formatColumnLine(newColumnDef)}`;

  // insertLineNumber は1始まりの行番号。この行の「直前」に新しい行を割り込ませる
  // (=配列の該当インデックスの位置にspliceで挿入すれば、既存のその行はそのまま後ろにずれる)。
  const insertIndex = insertLineNumber - 1;
  const newLines = [...lines.slice(0, insertIndex), insertedLine, ...lines.slice(insertIndex)];

  return {
    newText: newLines.join(eol),
    insertedLine,
    insertedLineNumber: insertLineNumber,
  };
}

/** カラム名の重複チェック(大文字小文字を区別する完全一致。DBMLのカラム名は通常区別される)。 */
export function isDuplicateColumnName(table: DbmlTable, name: string): boolean {
  const trimmed = name.trim();
  return table.columns.some((c) => c.name === trimmed);
}
