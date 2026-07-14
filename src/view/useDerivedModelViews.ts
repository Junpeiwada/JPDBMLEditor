// model・viewMode から導出される表示用の派生値をまとめるフック(隣接グラフ・表示中テーブルID集合・
// フォーカス起点テーブルID・型入力候補)。いずれも model/viewMode が変わらない限り再計算不要なため
// useMemo で計算する。
import { useMemo } from "react";
import type { DbmlModel } from "../parser/model";
import type { ViewMode } from "./viewMode";
import { filterModel } from "./filter";
import { buildAdjacencyGraphFromModel, findTablesWithinHops, type AdjacencyGraph } from "../graph/adjacency";

export interface UseDerivedModelViewsResult {
  adjacencyGraph: AdjacencyGraph | null;
  visibleTableIds: ReadonlySet<string> | null;
  focusOriginId: string | null;
  typeOptions: string[];
}

export function useDerivedModelViews(
  model: DbmlModel | null,
  viewMode: ViewMode,
): UseDerivedModelViewsResult {
  // 隣接グラフは model が変わらない限り不変(ErCanvas 内部でも同じ計算をしているが、
  // 二重計算でも軽いためここでは共有せず素直に持つ)。
  const adjacencyGraph = useMemo(() => {
    if (!model) return null;
    return buildAdjacencyGraphFromModel(model);
  }, [model]);

  // 左パネル(テーブル一覧)用の「表示中テーブルID集合」。
  // 絞り込みモード: 検索ヒットテーブル / フォーカスモード: 起点+Nホップ近傍。
  // 全体モードでは null(=全テーブルを元の定義順で表示、薄字なし)。
  // SidePanel はこの集合に含まれるテーブルを一覧の上に並べ、含まれないものを薄字で下に置く。
  const visibleTableIds = useMemo(() => {
    if (!model) return null;
    if (viewMode.kind === "filter") {
      return filterModel(model, viewMode.query).matchedTableIds;
    }
    if (viewMode.kind === "focus" && adjacencyGraph) {
      return findTablesWithinHops(adjacencyGraph, viewMode.tableId, viewMode.hops);
    }
    return null;
  }, [model, viewMode, adjacencyGraph]);

  // フォーカス起点テーブルID(編集可能なテーブル)。
  const focusOriginId = viewMode.kind === "focus" ? viewMode.tableId : null;

  // 型入力候補: モデル中の既出型 + Enum名。フォーカス遷移のたびに再計算しないよう model のみに依存。
  const typeOptions = useMemo(() => {
    if (!model) return [];
    const set = new Set<string>();
    for (const table of model.tables) {
      for (const col of table.columns) {
        if (col.type) set.add(col.type);
      }
    }
    for (const en of model.enums) {
      set.add(en.name);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [model]);

  return { adjacencyGraph, visibleTableIds, focusOriginId, typeOptions };
}
