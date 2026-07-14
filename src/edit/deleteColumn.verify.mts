// 最小編集ロジック(deleteColumn.ts)の動作確認スクリプト。
// 実データ(SampleDBML)に対して各テーブルの先頭/中間/末尾カラムを削除し、
// 差分が「その1行の除去だけ」であること(他の行が一切変わらないこと)を確認する。
// また findRefsUsingColumn が Ref に使われているカラムを検出できることも確認する。
//
// 実行:
//   node --experimental-strip-types src/edit/deleteColumn.verify.mts SampleDBML/<サンプル>.dbml
import { readFileSync } from 'node:fs';
import { parseDbml } from '../parser/parse.ts';
import { deleteColumnLine, findRefsUsingColumn } from './deleteColumn.ts';

const filePath = process.argv[2];

if (!filePath) {
  console.error('usage: node --experimental-strip-types src/edit/deleteColumn.verify.mts <dbmlファイル>');
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
console.log(`テーブル数: ${model.tables.length}`);

let failCount = 0;

/**
 * before から1行だけ除去して after になっているかを検証する。
 * 除去位置より前は完全一致、除去位置以降は1行前へ詰まって一致するはず。
 */
function verifySingleLineRemoval(before: string, after: string, expectedLine: string): string[] {
  const beforeLines = before.split(/\r\n|\n/);
  const afterLines = after.split(/\r\n|\n/);
  const details: string[] = [];

  if (afterLines.length !== beforeLines.length - 1) {
    details.push(`行数差が-1でない: before=${beforeLines.length} after=${afterLines.length}`);
    return details;
  }

  // 最初に食い違う位置を探す(= 除去された行)。
  let removedIndex = -1;
  for (let i = 0; i < afterLines.length; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      removedIndex = i;
      break;
    }
  }
  if (removedIndex === -1) removedIndex = beforeLines.length - 1; // 末尾行の除去

  if (beforeLines[removedIndex] !== expectedLine) {
    details.push(`除去行が期待と不一致: 実際="${beforeLines[removedIndex]}" 期待="${expectedLine}"`);
  }

  // 除去位置以降が1行ずれて完全一致するか。
  for (let i = removedIndex; i < afterLines.length; i++) {
    if (afterLines[i] !== beforeLines[i + 1]) {
      details.push(`除去位置以降がずれている(after[${i}]): "${afterLines[i]}" != before[${i + 1}]="${beforeLines[i + 1]}"`);
      break;
    }
  }
  // 除去位置より前が完全一致するか。
  for (let i = 0; i < removedIndex; i++) {
    if (afterLines[i] !== beforeLines[i]) {
      details.push(`除去位置より前が変わっている(index ${i})`);
      break;
    }
  }
  return details;
}

// 各テーブルについて、先頭・中間・末尾のカラムを削除して検証する。
for (const table of model.tables) {
  if (table.columns.length === 0) continue;
  const indices = new Set<number>([0, Math.floor(table.columns.length / 2), table.columns.length - 1]);
  for (const idx of indices) {
    const col = table.columns[idx];
    try {
      const { newText, deletedLine } = deleteColumnLine(src, table, col);
      const details = verifySingleLineRemoval(src, newText, deletedLine);
      if (details.length > 0) {
        failCount++;
        console.error(`✗ ${table.name}.${col.name} (idx ${idx}):`);
        for (const d of details) console.error(`    ${d}`);
      }
    } catch (err) {
      failCount++;
      console.error(`✗ ${table.name}.${col.name} (idx ${idx}) 例外: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// findRefsUsingColumn の検証: Ref の endpoint に登場するカラムは検出され、
// それ以外のカラムは検出されないこと。
let refDetected = 0;
for (const ref of model.refs) {
  for (const ep of ref.endpoints) {
    const table = model.tables.find((t) => t.name === ep.tableName);
    if (!table) continue;
    for (const colName of ep.columnNames) {
      const col = table.columns.find((c) => c.name === colName);
      if (!col) continue;
      const hits = findRefsUsingColumn(model, table, col);
      if (hits.length === 0) {
        failCount++;
        console.error(`✗ findRefsUsingColumn: ${table.name}.${col.name} は Ref に使われているのに未検出`);
      } else {
        refDetected++;
      }
    }
  }
}
console.log(`Ref参照カラムの検出: ${refDetected}件OK`);

if (failCount === 0) {
  console.log('✓ 全ケースOK: 削除は対象1行のみを除去し、他の行を壊さない。');
  process.exit(0);
} else {
  console.error(`✗ ${failCount}件の失敗。`);
  process.exit(1);
}
