// 既存カラム定義行の最小編集(並べ替え)ロジック(純関数)。
//
// 原則(insertColumn.ts / deleteColumn.ts / replaceColumnLine.ts と対称): DBML全体を逆生成せず、
// 対象カラムと「隣のカラム」の定義行2行だけをテキストレベルで入れ替える。行の中身は一切書き換えない
// ため、属性・行末コメント・クォート流儀・インデントはそのまま移動する。
//
// 「切り出し(削除)+挿入」ではなく「2行のスワップ」を採る理由:
// - 1行移動(▲▼ボタン)は必ず隣接カラムとの交換になるため、スワップで完全に表現できる。
// - 削除+挿入だと token 由来の挿入位置解決(insertColumn.ts)を経由するが、削除後は行番号が
//   ずれてモデルの token と食い違う。スワップなら元テキストの行番号のまま完結し、
//   再パース前に2度位置解決する必要がない。
//
// 既知の制限(insertColumn.ts 冒頭の制限と同根): カラム定義の直前に独自コメント行(`// ...`)が
// ある場合、コメント行は元の位置に留まりカラム定義行だけが入れ替わる(コメントがカラムに
// 追従しない)。行自体は壊れない。SampleDBML の実データにはテーブルブロック内の行コメントが
// 存在しないため実害は未確認。将来そうしたデータに当たった場合は、直前のコメント行を
// カラムに属する塊として一緒に動かす改良が必要になる。
import type { DbmlColumn, DbmlTable } from '../parser/model';
import { findColumnDefLine } from './columnLineScan.ts';
import { assertColumnToken, splitSourceLines, throwColumnDefLineNotFound } from './sourceLines.ts';

export type MoveDirection = 'up' | 'down';

export interface MoveColumnResult {
  /** 並べ替え後の全文(changed=false のときは sourceText と同一)。 */
  newText: string;
  /** 実際に入れ替えが起きたか(端で移動できない場合は false)。 */
  changed: boolean;
  /** 入れ替え相手のカラム(changed=false のときは null)。 */
  swappedWith: DbmlColumn | null;
}

/**
 * 指定カラムの定義行を、1つ上/下の隣接カラムの定義行と入れ替える。
 *
 * 端(先頭カラムの up / 末尾カラムの down)では何もせず changed:false を返す
 * (呼び出し側はボタンを disabled にする想定だが、防御的に no-op とする)。
 *
 * @param sourceText 現在のDBML全文
 * @param table 対象テーブル(token情報つき。エラーメッセージ用)
 * @param column 移動するカラム(token情報が必須)
 * @param direction 'up' | 'down'
 */
export function moveColumnLine(
  sourceText: string,
  table: DbmlTable,
  column: DbmlColumn,
  direction: MoveDirection,
): MoveColumnResult {
  assertColumnToken(column);

  // モデル上の並び順で隣を決める(テキスト上の行順ではなく、画面に見えている順と一致させる)。
  const index = table.columns.findIndex((c) => c.id === column.id);
  if (index === -1) {
    throw new Error(`テーブル "${table.name}" にカラム "${column.name}" が見つかりません。`);
  }
  const neighborIndex = direction === 'up' ? index - 1 : index + 1;
  const neighbor = table.columns[neighborIndex];
  if (!neighbor) {
    // 端。移動不可だがエラーではない。
    return { newText: sourceText, changed: false, swappedWith: null };
  }
  assertColumnToken(neighbor);

  const { eol, lines } = splitSourceLines(sourceText);

  // 対象行の特定は findColumnDefLine に集約(replace/delete と共通)。
  const found = findColumnDefLine(lines, column);
  const foundNeighbor = findColumnDefLine(lines, neighbor);
  if (!found || !foundNeighbor) {
    const missing = found ? neighbor : column;
    throwColumnDefLineNotFound(table, missing, '移動');
  }
  if (found.lineNumber === foundNeighbor.lineNumber) {
    // 同一行に解決されることは通常ありえない(防御)。壊すより何もしない方を選ぶ。
    return { newText: sourceText, changed: false, swappedWith: null };
  }

  // 行を丸ごと入れ替える(中身は一切書き換えないので属性・行末コメントごと移動する)。
  const newLines = [...lines];
  newLines[found.lineNumber - 1] = foundNeighbor.originalLine;
  newLines[foundNeighbor.lineNumber - 1] = found.originalLine;

  return { newText: newLines.join(eol), changed: true, swappedWith: neighbor };
}
