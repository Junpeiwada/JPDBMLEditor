// 最小編集ロジック(insertColumn.ts)の動作確認スクリプト。
// 実データ(SampleDBML)に対して「上に挿入」「下に挿入」「テーブル末尾に挿入」を実行し、
// 差分が期待の1行だけであること(他の行が一切変わらないこと)を確認する。
// 実データのコメント・Enum・日本語noteが壊れないことも確認する。
//
// 実行:
//   node --experimental-strip-types src/edit/insertColumn.verify.mts SampleDBML/<サンプル>.dbml
import { readFileSync } from 'node:fs';
import { parseDbml } from '../parser/parse.ts';
import { insertColumnLine, type InsertPosition } from './insertColumn.ts';
import type { ColumnInput } from './lineFormat.ts';

const filePath = process.argv[2];

if (!filePath) {
  console.error('usage: node --experimental-strip-types src/edit/insertColumn.verify.mts <dbmlファイル>');
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

/** 2つのテキストの行単位diffを取り、変更行数を数える(単純な同一インデックス比較)。 */
function diffLineCount(before: string, after: string): { changed: number; added: number; details: string[] } {
  const beforeLines = before.split(/\r\n|\n/);
  const afterLines = after.split(/\r\n|\n/);
  const details: string[] = [];

  if (afterLines.length !== beforeLines.length + 1) {
    details.push(`行数差が1でない: before=${beforeLines.length} after=${afterLines.length}`);
  }

  // 挿入位置より前は完全一致するはず。挿入位置以降は1行ずれて一致するはず。
  let firstDiffIndex = -1;
  for (let i = 0; i < beforeLines.length; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      firstDiffIndex = i;
      break;
    }
  }

  if (firstDiffIndex === -1) {
    // 末尾に1行追加されたケース(通常は発生しない想定だが念のため)。
    return { changed: 0, added: 1, details };
  }

  // firstDiffIndex以降、afterはbeforeよりも1行分ずれているはず。
  let mismatches = 0;
  for (let i = firstDiffIndex; i < beforeLines.length; i++) {
    if (beforeLines[i] !== afterLines[i + 1]) {
      mismatches++;
      details.push(`不一致 (before行${i + 1}): "${beforeLines[i]}" != (after行${i + 2}): "${afterLines[i + 1]}"`);
    }
  }

  return { changed: mismatches, added: 1, details };
}

function runCase(
  tableName: string,
  anchorColumnName: string | null,
  position: InsertPosition,
  newColumn: ColumnInput,
) {
  const table = model.tables.find((t) => t.name === tableName);
  if (!table) {
    console.error(`  [FAIL] テーブルが見つかりません: ${tableName}`);
    failCount++;
    return;
  }
  const anchorColumn = anchorColumnName ? table.columns.find((c) => c.name === anchorColumnName) ?? null : null;
  if (anchorColumnName && !anchorColumn) {
    console.error(`  [FAIL] アンカーカラムが見つかりません: ${anchorColumnName}`);
    failCount++;
    return;
  }

  try {
    const { newText, insertedLine, insertedLineNumber } = insertColumnLine(
      src,
      table,
      anchorColumn,
      position,
      newColumn,
    );

    const diff = diffLineCount(src, newText);
    const ok = diff.changed === 0 && diff.added === 1;
    console.log(
      `  [${ok ? 'OK' : 'FAIL'}] table=${tableName} anchor=${anchorColumnName ?? '(末尾)'} position=${position} ` +
        `-> 行${insertedLineNumber}に挿入: "${insertedLine.trim()}" (変更行数=${diff.changed}, 追加=${diff.added})`,
    );
    if (!ok) {
      failCount++;
      for (const d of diff.details) console.log(`      ${d}`);
    }

    // 再パースして壊れていないか確認(挿入した行を含め、後続テーブルもパース可能なままか)。
    const reparsed = parseDbml(newText);
    if (!reparsed.ok) {
      console.error(`  [FAIL] 挿入後の再パースに失敗: ${reparsed.error.message} (${reparsed.error.line}行目)`);
      failCount++;
    } else {
      const reparsedTable = reparsed.model.tables.find((t) => t.name === tableName);
      const hasNewColumn = reparsedTable?.columns.some((c) => c.name === newColumn.name.trim());
      if (!hasNewColumn) {
        console.error(`  [FAIL] 再パース後に新カラムが見つかりません: ${newColumn.name}`);
        failCount++;
      }
    }
  } catch (err) {
    console.error(`  [FAIL] 例外: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }
}

console.log('\n--- ケース1: 先頭カラムの上に挿入 ---');
const firstTable = model.tables[0];
const firstColumn = firstTable.columns[0];
runCase(firstTable.name, firstColumn.name, 'above', {
  name: 'テスト追加カラムA',
  type: 'varchar(10)',
  pk: false,
  notNull: true,
  defaultValue: '',
  note: '',
});

console.log('\n--- ケース2: 中間カラムの下に挿入 ---');
const midIndex = Math.floor(firstTable.columns.length / 2);
const midColumn = firstTable.columns[midIndex];
runCase(firstTable.name, midColumn.name, 'below', {
  name: 'テスト追加カラムB',
  type: 'int',
  pk: false,
  notNull: false,
  defaultValue: '0',
  note: 'テスト用のnote\n改行あり',
});

console.log('\n--- ケース3: テーブル末尾に挿入 ---');
runCase(firstTable.name, null, 'end', {
  name: 'テスト追加カラムC',
  type: 'datetime2',
  pk: false,
  notNull: true,
  defaultValue: '`SYSDATETIME()`',
  note: "エスケープ確認: 'シングルクォート'",
});

// 複数テーブルある場合、2つ目のテーブルでも末尾挿入を確認(Note:行の有無に関わらず安全か)。
if (model.tables.length > 1) {
  console.log('\n--- ケース4: 2つ目のテーブルの末尾に挿入 ---');
  const secondTable = model.tables[1];
  runCase(secondTable.name, null, 'end', {
    name: 'テスト追加カラムD',
    type: 'int',
    pk: false,
    notNull: false,
  });
}

// 最後のカラムをアンカーに「上に挿入」(末尾挿入と混同していないか確認)。
console.log('\n--- ケース5: 最後のカラムの上に挿入 ---');
const lastColumn = firstTable.columns[firstTable.columns.length - 1];
runCase(firstTable.name, lastColumn.name, 'above', {
  name: 'テスト追加カラムE',
  type: 'int',
  pk: false,
  notNull: false,
});

// ケース6: カラム定義の間に独自コメント(// ...)が挟まる合成データでの確認。
// SampleDBML実データにはテーブルブロック内の// コメントが存在しなかった(テーブル間のみ)ため、
// Docs/spike-位置情報.md が指摘する「コメント行はどのフィールドのtokenにも属さない」ケースを
// 合成データで明示的に検証する。コメント行を挟んでも @dbml/core の token.end.line が
// 次カラムの開始行(コメント行の次)を指すことを利用し、コメントより前に安全に挿入できるか確認する。
console.log('\n--- ケース6: カラム間にコメントを含む合成データ ---');
{
  const synthSrc = [
    'Table T {',
    '  "a" int [pk]',
    '  // 独自コメント: このカラムより上には触れないこと',
    '  "b" varchar(10)',
    '  "c" int',
    '}',
    '',
  ].join('\n');
  const synthResult = parseDbml(synthSrc);
  if (!synthResult.ok) {
    console.error('  [FAIL] 合成データのパースに失敗:', synthResult.error);
    failCount++;
  } else {
    const synthTable = synthResult.model.tables[0];
    const colA = synthTable.columns.find((c) => c.name === 'a')!;
    const colB = synthTable.columns.find((c) => c.name === 'b')!;

    // "a"の下に挿入 -> コメント行を巻き込まず、コメントの直前に入るべき
    // (token.end.line は次フィールド"b"の開始行=コメントの次行を指すため、コメントより後ろに入る点に注意。
    //  つまり「aの下」はコメントの手前ではなく、コメントの後ろ(bの直前)になるのが実際の挙動。
    //  ここではその挙動を明示し、コメント行自体の文字列が変化しないことのみを厳密に確認する)。
    const { newText: afterA } = insertColumnLine(synthSrc, synthTable, colA, 'below', {
      name: 'x1',
      type: 'int',
      pk: false,
      notNull: false,
    });
    const commentLineBefore = synthSrc.split('\n').find((l) => l.includes('独自コメント'));
    const commentLineAfter = afterA.split('\n').find((l) => l.includes('独自コメント'));
    const commentPreserved = commentLineBefore === commentLineAfter;
    console.log(`  [${commentPreserved ? 'OK' : 'FAIL'}] "a"の下に挿入してもコメント行の文字列は不変`);
    if (!commentPreserved) failCount++;

    // 既知の制限: "b"の直前のコメント行は @dbml/core 上、"a".token.end と "b".token.start が
    // 同じ行(コメント行)を指すため、「bの上に挿入」は実際には「コメントの上」に入る
    // (コメントの直後・bの直前には入らない)。コメント行自体の文字列は壊れないが、
    // 挿入位置が視覚的にコメントを飛び越える点は既知の制限としてドキュメント化する
    // (Docs/spike-位置情報.md で示唆されていた「コメントが絡む並べ替えは要再検証」の実例)。
    const { newText: afterB } = insertColumnLine(synthSrc, synthTable, colB, 'above', {
      name: 'x2',
      type: 'int',
      pk: false,
      notNull: false,
    });
    const beforeLines = synthSrc.split('\n');
    const afterLines = afterB.split('\n');
    const beforeCommentIndex = beforeLines.findIndex((l) => l.includes('独自コメント'));
    const afterCommentIndex = afterLines.findIndex((l) => l.includes('独自コメント'));
    // コメント行自体の文字列は変化しないこと(挿入により1行分ずれるだけ)。
    const commentLineIntact = afterLines[afterCommentIndex] === beforeLines[beforeCommentIndex];
    // 実際の挿入位置はコメント行の直前になる(既知の制限)。
    const insertedBeforeComment = afterLines[afterCommentIndex - 1]?.includes('"x2"');
    const behaviorAsExpected = commentLineIntact && insertedBeforeComment;
    console.log(
      `  [${behaviorAsExpected ? 'OK' : 'FAIL'}] "b"の上に挿入 -> コメント文字列は不変だが、挿入位置はコメントの直前になる(既知の制限)`,
    );
    if (!behaviorAsExpected) failCount++;
  }
}

console.log(`\n=== 結果: ${failCount === 0 ? '全ケースOK' : `${failCount}件FAIL`} ===`);
process.exit(failCount === 0 ? 0 : 1);
