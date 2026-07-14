// 検索フィルタ(filter.ts)の動作確認スクリプト。
// 実データ(SampleDBML)をパースし、実際の filterModel/filterRefsByVisibleTables を通して
// ヒット件数などを標準出力に表示する。UI起動不要でロジックのみ検証する。
//
// 実行:
//   node --experimental-strip-types src/view/filter.verify.mts SampleDBML/<サンプル>.dbml <検索語...>
import { readFileSync } from 'node:fs';
import { parseDbml } from '../parser/parse.ts';
import { filterModel, filterRefsByVisibleTables, isEmptyQuery, normalizeQuery } from './filter.ts';

const filePath = process.argv[2];
const queries = process.argv.slice(3);

if (!filePath || queries.length === 0) {
  console.error('usage: node --experimental-strip-types src/view/filter.verify.mts <dbmlファイル> <query...>');
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

// 空クエリ/空白クエリの扱い確認
console.log('\n--- 前提チェック ---');
console.log('isEmptyQuery(""):', isEmptyQuery(''));
console.log('isEmptyQuery("  "):', isEmptyQuery('  '));
console.log('normalizeQuery("  abc  "):', JSON.stringify(normalizeQuery('  abc  ')));

for (const query of queries) {
  const { matchedTableIds, matchesByTableId } = filterModel(model, query);
  const visibleRefs = filterRefsByVisibleTables(model.refs, matchedTableIds);

  console.log(`\n--- query: "${query}" ---`);
  console.log(`ヒットテーブル数: ${matchedTableIds.size}`);
  console.log(`表示エッジ数(両端ヒット): ${visibleRefs.length}`);

  const details = [...matchesByTableId.values()].slice(0, 10).map((m) => ({
    table: m.tableId,
    tableNameMatched: m.tableNameMatched,
    matchedColumns: m.matchedColumnIds.size,
  }));
  console.log('内訳(先頭10件):', details);
}

// 大文字小文字を区別しないことの確認(テーブル名 or カラム名に含まれる語で軽く自己チェック)
console.log('\n--- 大文字小文字非区別チェック ---');
const sampleTable = model.tables[0];
if (sampleTable) {
  const lower = sampleTable.name.toLowerCase();
  const upper = sampleTable.name.toUpperCase();
  const rLower = filterModel(model, lower).matchedTableIds.has(sampleTable.id);
  const rUpper = filterModel(model, upper).matchedTableIds.has(sampleTable.id);
  console.log(`table[0] = ${sampleTable.name}, lower-match=${rLower}, upper-match=${rUpper}`);
}
