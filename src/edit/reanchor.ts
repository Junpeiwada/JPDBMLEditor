// 保存衝突時(「自分の編集を保持」を選んだ場合)に使う再特定ロジック。
// 外部変更で再パースした最新モデルに対し、編集セッション開始時に覚えていた
// テーブル/アンカーカラムを「名前」で引き直す。token(位置情報)は再パースのたびに
// 失効するため、常に最新モデルの token を使う必要がある。
import type { DbmlModel, DbmlTable, DbmlColumn } from '../parser/model';

export interface ReanchorTarget {
  tableName: string;
  /** アンカーカラム名(null なら テーブル末尾への追加)。 */
  anchorColumnName: string | null;
}

export interface ReanchorResult {
  table: DbmlTable;
  anchorColumn: DbmlColumn | null;
}

/**
 * 最新モデルからテーブル名(+アンカーカラム名)を再特定する。
 * テーブルが見つからない、またはアンカーカラムが見つからない場合は null を返す
 * (呼び出し側でエラートーストを出して中断する)。
 */
export function reanchor(model: DbmlModel, target: ReanchorTarget): ReanchorResult | null {
  const table = model.tables.find((t) => t.name === target.tableName);
  if (!table) return null;

  if (target.anchorColumnName === null) {
    return { table, anchorColumn: null };
  }

  const anchorColumn = table.columns.find((c) => c.name === target.anchorColumnName);
  if (!anchorColumn) return null;

  return { table, anchorColumn };
}
