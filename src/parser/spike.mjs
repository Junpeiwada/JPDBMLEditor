// spike: @dbml/core のパース結果に含まれる位置情報（トークンレンジ）を調査するスクリプト。
// Node で直接実行できる（UI起動不要）。
//
// 実行:
//   node src/parser/spike.mjs SampleDBML/<サンプル>.dbml

import { readFileSync } from 'node:fs';
import { Parser } from '@dbml/core';

const filePath = process.argv[2];
if (!filePath) {
  console.error('usage: node src/parser/spike.mjs <dbmlファイルパス>');
  process.exit(1);
}

const src = readFileSync(filePath, 'utf-8');
const parser = new Parser();
const database = parser.parse(src, 'dbml');

console.log(`=== ${filePath} ===`);
console.log('schemas:', database.schemas.length);

let tableCount = 0;
let fieldCount = 0;
let refCount = 0;

for (const schema of database.schemas) {
  tableCount += schema.tables.length;
  refCount += schema.refs.length;

  for (const table of schema.tables.slice(0, 2)) {
    // テーブル単位のトークン(レンジ)確認
    console.log('--- table ---', table.name);
    console.log('table.token:', JSON.stringify(table.token));
    console.log('table.noteToken:', JSON.stringify(table.noteToken));

    for (const field of table.fields.slice(0, 3)) {
      fieldCount++;
      console.log(`  field ${field.name} token:`, JSON.stringify(field.token));
    }
    fieldCount += Math.max(0, table.fields.length - 3);
  }

  for (const table of schema.tables.slice(2)) {
    fieldCount += table.fields.length;
  }

  for (const ref of schema.refs.slice(0, 2)) {
    console.log('--- ref ---', ref.name || '(no name)');
    console.log('ref.token:', JSON.stringify(ref.token));
    for (const ep of ref.endpoints) {
      console.log('  endpoint:', ep.tableName, ep.fieldNames, 'relation:', ep.relation, 'token:', JSON.stringify(ep.token));
    }
  }
}

console.log('=== summary ===');
console.log('table count:', tableCount);
console.log('field count (approx, all fields):', fieldCount);
console.log('ref count:', refCount);

// 元テキストからトークンレンジで切り出せるか確認(1個目のテーブルで)
const firstTable = database.schemas[0]?.tables[0];
if (firstTable?.token) {
  const lines = src.split('\n');
  const { start, end } = firstTable.token;
  const slice = lines.slice(start.line - 1, end.line).join('\n');
  console.log('=== 最初のテーブルをトークンレンジで切り出し ===');
  console.log(slice.slice(0, 300));
}

const firstField = firstTable?.fields[0];
if (firstField?.token) {
  const lines = src.split('\n');
  const { start, end } = firstField.token;
  const slice = lines.slice(start.line - 1, end.line).join('\n');
  console.log('=== 最初のフィールドをトークンレンジで切り出し ===');
  console.log(slice);
}
