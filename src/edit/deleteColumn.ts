// 既存カラム定義行の最小編集(削除)ロジック(純関数)。
//
// 原則(insertColumn.ts / replaceColumnLine.ts と対称): DBML全体を逆生成せず、対象カラムの
// 定義行を1行だけ丸ごと取り除く。隣接カラム・テーブル末尾の `Note: '...'` 行・`}`・
// 行末コメント・整形は一切壊さない。
//
// 対象行の特定は replaceColumnLine と同じ手法をとる: 通常は token.start.line がカラム定義行だが、
// カラムの直前に独自コメント行(// ...)があると token.start.line はコメント行を指す
// (insertColumn.ts 冒頭の既知の制限と同根)。そのため token の行範囲内を前方走査し、
// パースした名前が対象カラムと一致する行を採用する。
import type { DbmlColumn, DbmlModel, DbmlTable } from '../parser/model';
import { findColumnDefLine } from './columnLineScan.ts';
import { assertColumnToken, splitSourceLines, throwColumnDefLineNotFound } from './sourceLines.ts';

export interface DeleteColumnResult {
  /** 削除後の全文。 */
  newText: string;
  /** 削除された行の内容(インデント込み)。 */
  deletedLine: string;
  /** 削除された行番号(1始まり、元テキスト上の行番号)。 */
  deletedLineNumber: number;
}

/**
 * テーブル定義ブロックから、指定カラムの定義行を1行だけ丸ごと削除する。
 *
 * @param sourceText 現在のDBML全文
 * @param table 対象テーブル(token情報つき。エラーメッセージ用)
 * @param column 対象カラム(token情報が必須)
 */
export function deleteColumnLine(
  sourceText: string,
  table: DbmlTable,
  column: DbmlColumn,
): DeleteColumnResult {
  assertColumnToken(column);

  const { eol, lines } = splitSourceLines(sourceText);

  // 対象行の特定は findColumnDefLine に集約(replaceColumnLine と共通)。
  const found = findColumnDefLine(lines, column);
  if (!found) {
    throwColumnDefLineNotFound(table, column, '削除');
  }
  const { lineNumber, originalLine: deletedLine } = found;

  // 該当行を配列から除去する(前後の行はそのまま詰まる)。
  const newLines = [...lines.slice(0, lineNumber - 1), ...lines.slice(lineNumber)];

  return {
    newText: newLines.join(eol),
    deletedLine,
    deletedLineNumber: lineNumber,
  };
}

/**
 * 指定テーブルの指定カラムが、いずれかの Ref の endpoint に使われているか判定する。
 * true の場合、このカラムを削除すると Ref 定義が壊れて DBML が不正になる
 * (削除前の警告・確認に使う)。
 *
 * 判定はテーブル名+カラム名の一致で行う(endpoint は tableName/columnNames を持つ)。
 * 複合キー(columnNames が複数)でも、対象カラム名が含まれていればヒットとみなす。
 *
 * 注意: ep.tableName と table.name はいずれも parse.ts が同じ規則で正規化した「スキーマ抜きの
 * テーブル名」(別名解決済み)である前提。スキーマ修飾や別名で表記が食い違うと取りこぼす可能性が
 * あるが、本関数は「削除前の警告」用途であり、取りこぼしても最終的に applyEdit の再パース検証で
 * 不正 DBML として弾かれる(二段構え)ため致命的ではない。
 */
export function findRefsUsingColumn(
  model: DbmlModel,
  table: DbmlTable,
  column: DbmlColumn,
): DbmlModel['refs'] {
  return model.refs.filter((ref) =>
    ref.endpoints.some(
      (ep) => ep.tableName === table.name && ep.columnNames.includes(column.name),
    ),
  );
}
