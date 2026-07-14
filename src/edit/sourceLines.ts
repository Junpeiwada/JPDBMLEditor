// insertColumn.ts / deleteColumn.ts / moveColumn.ts / replaceColumnLine.ts の4モジュールで
// 共通する下ごしらえ・エラー生成ロジック(純関数)。
//
// 各モジュールは「sourceTextを改行分割する」「対象カラムのtoken有無を検証する」
// 「定義行が特定できなかった場合のエラーを組み立てる」という同じ手順を踏むため、
// ここに集約して重複を排除する。
import type { DbmlColumn, DbmlTable, TokenRange } from '../parser/model';

/** sourceText を改行コード別に分割した結果。 */
export interface SourceLines {
  /** 検出された改行コード('\r\n' または '\n')。生成する行もこれに揃える。 */
  eol: string;
  /** 改行で分割した行配列。 */
  lines: string[];
}

/**
 * sourceText の改行コードを検出し、行配列に分割する
 * (既存ファイルの改行方式を壊さないよう、生成する行もeolに揃える)。
 */
export function splitSourceLines(sourceText: string): SourceLines {
  const eol = sourceText.includes('\r\n') ? '\r\n' : '\n';
  const lines = sourceText.split(/\r\n|\n/);
  return { eol, lines };
}

/** token(位置情報)を持つことが保証されたカラム。 */
export interface ColumnWithToken extends DbmlColumn {
  token: TokenRange;
}

/**
 * カラムが token(位置情報) を持つことを検証する。無ければエラーを投げる。
 * 呼び出し以降、TypeScript上も column.token が非undefinedとして扱われる。
 */
export function assertColumnToken(column: DbmlColumn): asserts column is ColumnWithToken {
  if (!column.token) {
    throw new Error(`カラム "${column.name}" の位置情報が取得できません(token未取得)。`);
  }
}

/**
 * findColumnDefLine が定義行を特定できなかった場合の共通エラーを投げる。
 * actionLabel は「削除」「移動」「編集」など、呼び出し元の操作名。
 */
export function throwColumnDefLineNotFound(
  table: DbmlTable,
  column: ColumnWithToken,
  actionLabel: string,
): never {
  const scanStart = column.token.start.line;
  const scanEnd = Math.max(scanStart, column.token.end.line);
  throw new Error(
    `テーブル "${table.name}" のカラム "${column.name}" の定義行(${scanStart}〜${scanEnd}行目)を特定できませんでした。${actionLabel}を中断します。`,
  );
}
