import type { DbmlModel } from '../parser/model';
import { estimateTableNodeSize } from './nodeSize';
import { elkLayout } from './elkLayout';
import type { LayoutResult } from './types';
import { perfSpanAsync } from '../perf/perf';

export * from './types';
export { estimateTableNodeSize } from './nodeSize';

/**
 * DbmlModel から ELK でテーブルノードの座標を計算する。
 * tableIds を渡すと、そのテーブルのみを対象に部分レイアウトする(絞り込み表示用)。
 */
export async function computeTableLayout(
  model: DbmlModel,
  tableIds?: ReadonlySet<string>,
): Promise<LayoutResult> {
  const tables = tableIds ? model.tables.filter((t) => tableIds.has(t.id)) : model.tables;

  const nodes = tables.map((table) => {
    const size = estimateTableNodeSize(table);
    return { id: table.id, width: size.width, height: size.height };
  });

  const edges = model.refs
    .filter((ref) => {
      if (!tableIds) return true;
      return tableIds.has(ref.endpoints[0].tableId) && tableIds.has(ref.endpoints[1].tableId);
    })
    .map((ref) => ({
      id: ref.id,
      source: ref.endpoints[0].tableId,
      target: ref.endpoints[1].tableId,
    }));

  return perfSpanAsync(
    '3|layout:ELK計算',
    () => elkLayout({ nodes, edges }),
    () => `${nodes.length}ノード / ${edges.length}辺`,
  );
}
