// 検索フィルタのロジック(純関数)。
// テーブル名・カラム名を対象に大文字小文字を区別しない部分一致でマッチングする。
// UI (ErCanvas 等) から呼び出しやすいよう、DOM/Reactに依存しない形にしている。
import type { DbmlModel, DbmlRef } from '../parser/model';

/** テーブル1件分のマッチ結果。 */
export interface TableMatch {
  tableId: string;
  /** テーブル名自体がヒットしたか。 */
  tableNameMatched: boolean;
  /** ヒットしたカラムのID一覧(ハイライト対象)。 */
  matchedColumnIds: Set<string>;
}

/** 絞り込みフィルタの計算結果。 */
export interface FilterResult {
  /** ヒットしたテーブルIDの集合。 */
  matchedTableIds: Set<string>;
  /** テーブルIDごとのマッチ詳細(ハイライト用)。 */
  matchesByTableId: Map<string, TableMatch>;
}

/** クエリの前後空白を除いた実質的な検索語。空なら絞り込み無効(全体表示)とみなす。 */
export function normalizeQuery(query: string): string {
  return query.trim();
}

/** 空クエリ(前後空白のみ含む)かどうか。 */
export function isEmptyQuery(query: string): boolean {
  return normalizeQuery(query).length === 0;
}

/**
 * モデルに対してクエリで絞り込みを行う。
 * テーブル名 or カラム名が部分一致(大文字小文字区別なし)したテーブルをヒットとする。
 */
export function filterModel(model: DbmlModel, query: string): FilterResult {
  const normalized = normalizeQuery(query).toLowerCase();
  const matchedTableIds = new Set<string>();
  const matchesByTableId = new Map<string, TableMatch>();

  if (normalized.length === 0) {
    return { matchedTableIds, matchesByTableId };
  }

  for (const table of model.tables) {
    const tableNameMatched = table.name.toLowerCase().includes(normalized);
    const matchedColumnIds = new Set<string>();

    for (const col of table.columns) {
      if (col.name.toLowerCase().includes(normalized)) {
        matchedColumnIds.add(col.id);
      }
    }

    if (tableNameMatched || matchedColumnIds.size > 0) {
      matchedTableIds.add(table.id);
      matchesByTableId.set(table.id, {
        tableId: table.id,
        tableNameMatched,
        matchedColumnIds,
      });
    }
  }

  return { matchedTableIds, matchesByTableId };
}

/** 両端が表示中テーブル集合に含まれる Ref のみを残す(絞り込み中のエッジ表示判定)。 */
export function filterRefsByVisibleTables(
  refs: readonly DbmlRef[],
  visibleTableIds: ReadonlySet<string>,
): DbmlRef[] {
  return refs.filter(
    (ref) =>
      visibleTableIds.has(ref.endpoints[0].tableId) && visibleTableIds.has(ref.endpoints[1].tableId),
  );
}
