// テーブル間の隣接グラフ構築とNホップ探索(純関数)。
// フォーカスモード(view)がクリックしたテーブルの近傍を求めるために使う。
// DOM/Reactに依存しない形にしている(filter.ts と同様の方針)。
import type { DbmlModel, DbmlRef } from '../parser/model';

/** テーブルIDをキーに、隣接するテーブルID集合を持つ無向隣接グラフ。 */
export type AdjacencyGraph = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Ref(リレーション)一覧から無向の隣接グラフを構築する。
 * 自己参照(endpoints[0] === endpoints[1])は隣接として追加しない。
 */
export function buildAdjacencyGraph(refs: readonly DbmlRef[]): AdjacencyGraph {
  const graph = new Map<string, Set<string>>();

  const ensure = (tableId: string): Set<string> => {
    let set = graph.get(tableId);
    if (!set) {
      set = new Set();
      graph.set(tableId, set);
    }
    return set;
  };

  for (const ref of refs) {
    const [a, b] = ref.endpoints;
    if (a.tableId === b.tableId) continue;
    ensure(a.tableId).add(b.tableId);
    ensure(b.tableId).add(a.tableId);
  }

  return graph;
}

/**
 * モデル全体から隣接グラフを構築する。孤立テーブル(Refに登場しない)も
 * 空集合のエントリとしてグラフに含める(呼び出し側が has() で判定しやすいように)。
 */
export function buildAdjacencyGraphFromModel(model: DbmlModel): AdjacencyGraph {
  const graph = new Map<string, Set<string>>();
  for (const table of model.tables) {
    graph.set(table.id, new Set());
  }
  const refGraph = buildAdjacencyGraph(model.refs);
  for (const [tableId, neighbors] of refGraph) {
    const set = graph.get(tableId) ?? new Set<string>();
    for (const n of neighbors) set.add(n);
    graph.set(tableId, set);
  }
  return graph;
}

/**
 * 起点テーブルからNホップ以内(0 = 起点のみ)で到達できるテーブルID集合をBFSで求める。
 * 戻り値には起点自身も含む。起点がグラフに存在しない場合は起点のみの集合を返す。
 */
export function findTablesWithinHops(
  graph: AdjacencyGraph,
  startTableId: string,
  hops: number,
): Set<string> {
  const visited = new Set<string>([startTableId]);
  if (hops <= 0) return visited;

  let frontier = [startTableId];
  for (let depth = 0; depth < hops; depth++) {
    const next: string[] = [];
    for (const tableId of frontier) {
      const neighbors = graph.get(tableId);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return visited;
}
