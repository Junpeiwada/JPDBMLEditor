// 隣接グラフ・Nホップ探索(adjacency.ts)の動作確認スクリプト。
// 実データ(SampleDBML)をパースし、Refが多いテーブルを起点に1/2/3ホップの
// 表示テーブル件数を標準出力に表示する。UI起動不要でロジックのみ検証する。
//
// 実行:
//   node --experimental-strip-types src/graph/adjacency.verify.mts SampleDBML/<サンプル>.dbml
import { readFileSync } from 'node:fs';
import { parseDbml } from '../parser/parse.ts';
import { buildAdjacencyGraphFromModel, findTablesWithinHops } from './adjacency.ts';

const filePath = process.argv[2];

if (!filePath) {
  console.error('usage: node --experimental-strip-types src/graph/adjacency.verify.mts <dbmlファイル>');
  process.exit(1);
}

const src = readFileSync(filePath, 'utf-8');
const result = parseDbml(src);

if (!result.ok) {
  console.error('パース失敗:', result.error);
  process.exit(1);
}

const model = result.model;
console.log(`=== ${filePath} ===`);
console.log(`テーブル数: ${model.tables.length} / Ref数: ${model.refs.length}`);

const graph = buildAdjacencyGraphFromModel(model);

// 次数(隣接テーブル数)を集計し、Refが多いテーブルを起点に選ぶ。
const degrees = [...graph.entries()]
  .map(([tableId, neighbors]) => ({ tableId, degree: neighbors.size }))
  .sort((a, b) => b.degree - a.degree);

console.log('\n--- 次数上位10テーブル ---');
for (const { tableId, degree } of degrees.slice(0, 10)) {
  console.log(`${tableId}: 隣接 ${degree} テーブル`);
}

// 孤立テーブル(隣接0)の件数
const isolatedCount = degrees.filter((d) => d.degree === 0).length;
console.log(`\n孤立テーブル(隣接0)数: ${isolatedCount} / ${model.tables.length}`);

const topTables = degrees.slice(0, 3).map((d) => d.tableId);

for (const startTableId of topTables) {
  console.log(`\n--- 起点: ${startTableId} ---`);
  for (const hops of [0, 1, 2, 3]) {
    const within = findTablesWithinHops(graph, startTableId, hops);
    console.log(`  ${hops}ホップ: ${within.size} テーブル表示`);
  }
}

// 存在しないテーブルIDを起点にしたときの防御確認
console.log('\n--- 存在しないテーブルIDでの防御確認 ---');
const bogus = findTablesWithinHops(graph, '__not_exist__', 2);
console.log(`起点のみ返る: ${bogus.size === 1 && bogus.has('__not_exist__')}`);

// hops=0 は起点のみであることの確認
if (topTables[0]) {
  const zeroHop = findTablesWithinHops(graph, topTables[0], 0);
  console.log(`\nhops=0 は起点のみ: ${zeroHop.size === 1 && zeroHop.has(topTables[0])}`);
}
