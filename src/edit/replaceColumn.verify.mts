// 既存カラム行の最小編集置換(replaceColumnLine.ts)の動作確認スクリプト。
// 実データ(SampleDBML)に対して名前変更/型変更/not nullトグル/note編集/default追加・削除を実行し、
// 差分が対象1行のみであること・再パースできることを確認する。
// 合成ケースで unique / increment / 行末コメントの温存も確認する。
//
// 実行:
//   node --experimental-strip-types src/edit/replaceColumn.verify.mts SampleDBML/<サンプル>.dbml
import { readFileSync } from 'node:fs';
import { parseDbml } from '../parser/parse.ts';
import { replaceColumnLine } from './replaceColumnLine.ts';
import { noteToInput, type ColumnInput } from './lineFormat.ts';
import type { DbmlModel, DbmlColumn } from '../parser/model.ts';

const filePath = process.argv[2];

if (!filePath) {
  console.error('usage: node --experimental-strip-types src/edit/replaceColumn.verify.mts <dbmlファイル>');
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

/** 行単位比較: 変更された行数と行数差を返す(置換は行数不変・変更1行のみが期待値)。 */
function diffChangedLines(before: string, after: string): { changed: number; lineCountDelta: number; details: string[] } {
  const beforeLines = before.split(/\r\n|\n/);
  const afterLines = after.split(/\r\n|\n/);
  const details: string[] = [];
  let changed = 0;
  const n = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < n; i++) {
    if (beforeLines[i] !== afterLines[i]) {
      changed++;
      if (details.length < 5) {
        details.push(`  行${i + 1}: "${beforeLines[i]}" -> "${afterLines[i]}"`);
      }
    }
  }
  return { changed, lineCountDelta: afterLines.length - beforeLines.length, details };
}

/** カラムの現状値から ColumnInput(UI入力表記)を作る(UIのプリフィルと同じ変換)。 */
function toInput(col: DbmlColumn): ColumnInput {
  return {
    name: col.name,
    type: col.type,
    pk: col.pk,
    notNull: col.notNull,
    defaultValue: col.dbdefault ?? '',
    note: col.note ? noteToInput(col.note) : '',
  };
}

function runCase(
  label: string,
  sourceText: string,
  sourceModel: DbmlModel,
  tableName: string,
  columnName: string,
  mutate: (input: ColumnInput) => ColumnInput,
  opts: { expectChanged?: boolean; expectPreserved?: string[] } = {},
) {
  const { expectChanged = true, expectPreserved = [] } = opts;
  const table = sourceModel.tables.find((t) => t.name === tableName);
  const column = table?.columns.find((c) => c.name === columnName);
  if (!table || !column) {
    console.error(`  [FAIL] ${label}: 対象が見つかりません (${tableName}.${columnName})`);
    failCount++;
    return;
  }

  try {
    const newDef = mutate(toInput(column));
    const { newText, newLine, changed, lineNumber } = replaceColumnLine(sourceText, table, column, newDef);

    if (!expectChanged) {
      const ok = !changed && newText === sourceText;
      console.log(`  [${ok ? 'OK' : 'FAIL'}] ${label}: changed=false でファイル不変`);
      if (!ok) failCount++;
      return;
    }

    const diff = diffChangedLines(sourceText, newText);
    let ok = changed && diff.changed === 1 && diff.lineCountDelta === 0;
    const problems: string[] = [];
    if (!changed) problems.push('changed=false が返った');
    if (diff.changed !== 1) problems.push(`変更行数=${diff.changed} (期待:1)`);
    if (diff.lineCountDelta !== 0) problems.push(`行数差=${diff.lineCountDelta} (期待:0)`);

    // 温存されるべき文字列(unique 等)が新しい行に残っているか
    for (const p of expectPreserved) {
      if (!newLine.includes(p)) {
        ok = false;
        problems.push(`温存されるべき "${p}" が消えた`);
      }
    }

    // 再パースできるか + 対象カラムがまだ(新しい名前で)存在するか
    const reparsed = parseDbml(newText);
    if (!reparsed.ok) {
      ok = false;
      problems.push(`再パース失敗: ${reparsed.error.message} (${reparsed.error.line}行目)`);
    } else {
      const newTable = reparsed.model.tables.find((t) => t.name === tableName);
      const found = newTable?.columns.some((c) => c.name === newDef.name.trim());
      if (!found) {
        ok = false;
        problems.push(`再パース後にカラム "${newDef.name}" が見つからない`);
      }
    }

    console.log(
      `  [${ok ? 'OK' : 'FAIL'}] ${label}: 行${lineNumber} 変更行数=${diff.changed} -> "${newLine.trim()}"`,
    );
    if (!ok) {
      failCount++;
      for (const p of problems) console.log(`      問題: ${p}`);
      for (const d of diff.details) console.log(`    ${d}`);
    }
  } catch (err) {
    console.error(`  [FAIL] ${label}: 例外: ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }
}

// ---------------------------------------------------------------
// 実データケース(1つ目のテーブルの実カラムを使う)
// ---------------------------------------------------------------
const firstTable = model.tables[0];

// ケースごとに適切な実カラムを探す(実データの代表例)
const colWithNote = firstTable.columns.find((c) => c.note && c.note.includes('\n')) ??
  firstTable.columns.find((c) => c.note);
// default削除ケース: 空文字default(`default: ''`)はプリフィルが「defaultなし」と区別できず
// 意図的に削除不能(既知の制限)なので、非空のdefaultを持つカラムを選ぶ。
const colWithDefault = firstTable.columns.find((c) => c.dbdefault != null && c.dbdefault.trim() !== '');
const colWithNotNull = firstTable.columns.find((c) => c.notNull && !c.pk);
// not null ON ケース: 現在 not null でないカラム(最初のテーブルに無ければ全テーブルから探す)。
const nullableHit = (() => {
  for (const t of model.tables) {
    const c = t.columns.find((c) => !c.notNull && !c.pk);
    if (c) return { table: t, col: c };
  }
  return null;
})();
// 型変更・default追加ケース: defaultを持たないカラム。
const colPlain = firstTable.columns.find((c) => !c.pk && !c.dbdefault && !c.note) ??
  firstTable.columns.find((c) => !c.pk && c.dbdefault == null) ?? firstTable.columns[1];

console.log('\n--- 実データ: 名前変更 ---');
// Ref のエンドポイントに登場するカラム(isForeignKey)をリネームすると Ref 側の参照が壊れて
// 再パースに失敗する(=意味的に正しい検出)。UI側は保存前パース検証で中断するため、
// ここでは Ref に参照されていないカラムを選ぶ。
const colRenamable = firstTable.columns.find((c) => !c.isForeignKey) ?? firstTable.columns[0];
runCase('名前変更', src, model, firstTable.name, colRenamable.name, (input) => ({
  ...input,
  name: 'リネーム後カラム名',
}));

console.log('\n--- 実データ: 型変更 ---');
runCase('型変更', src, model, firstTable.name, colPlain.name, (input) => ({
  ...input,
  type: 'nvarchar(999)',
}));

console.log('\n--- 実データ: not null トグル(OFF) ---');
if (colWithNotNull) {
  runCase('not null OFF', src, model, firstTable.name, colWithNotNull.name, (input) => ({
    ...input,
    notNull: false,
  }));
} else {
  console.log('  [SKIP] not null カラムなし');
}

console.log('\n--- 実データ: not null トグル(ON) ---');
if (nullableHit) {
  runCase('not null ON', src, model, nullableHit.table.name, nullableHit.col.name, (input) => ({
    ...input,
    notNull: true,
  }));
} else {
  console.log('  [SKIP] nullableカラムなし');
}

console.log('\n--- 実データ: note 編集(日本語・\\n入り) ---');
if (colWithNote) {
  runCase('note編集', src, model, firstTable.name, colWithNote.name, (input) => ({
    ...input,
    note: '編集後のnote\\n2行目：日本語',
  }));
} else {
  console.log('  [SKIP] note付きカラムなし');
}

console.log('\n--- 実データ: default 追加 ---');
runCase('default追加', src, model, firstTable.name, colPlain.name, (input) => ({
  ...input,
  defaultValue: '42',
}));

console.log('\n--- 実データ: default 削除 ---');
if (colWithDefault) {
  runCase('default削除', src, model, firstTable.name, colWithDefault.name, (input) => ({
    ...input,
    defaultValue: '',
  }));
} else {
  console.log('  [SKIP] default付きカラムなし');
}

console.log('\n--- 実データ: 無変更なら changed=false ---');
runCase('無変更', src, model, firstTable.name, firstTable.columns[0].name, (input) => input, {
  expectChanged: false,
});

// バッククォート式 default を持つカラムの無変更確認(該当カラムがあるサンプルのみ)
const tableWithBacktick = model.tables.find((t) => t.columns.some((c) => c.dbdefault === 'SYSDATETIME()'));
if (tableWithBacktick) {
  const btCol = tableWithBacktick.columns.find((c) => c.dbdefault === 'SYSDATETIME()')!;
  console.log('\n--- 実データ: バッククォート式defaultの温存(note編集のみ) ---');
  runCase(
    '式default温存',
    src,
    model,
    tableWithBacktick.name,
    btCol.name,
    (input) => ({ ...input, note: '式defaultはそのまま残ること' }),
    { expectPreserved: ['`SYSDATETIME()`'] },
  );
  console.log('\n--- 実データ: バッククォート式defaultカラムの無変更 ---');
  runCase('式default無変更', src, model, tableWithBacktick.name, btCol.name, (input) => input, {
    expectChanged: false,
  });
}

// ---------------------------------------------------------------
// 合成ケース: unique / increment / 行末コメント / インラインref の温存
// ---------------------------------------------------------------
console.log('\n--- 合成: unique+行末コメント温存(note のみ変更) ---');
{
  const synthSrc = [
    'Table T {',
    '  "x" int [pk, unique, not null, note: \'x\'] // 行末コメントは触らない',
    '  "y" varchar(10) [increment, default: 0]',
    '  "z" int [ref: > U.id, not null]',
    '}',
    '',
    'Table U {',
    '  "id" int [pk]',
    '}',
    '',
  ].join('\n');
  const synthResult = parseDbml(synthSrc);
  if (!synthResult.ok) {
    console.error('  [FAIL] 合成データのパースに失敗:', synthResult.error);
    failCount++;
  } else {
    const synthModel = synthResult.model;
    runCase(
      'unique+コメント温存',
      synthSrc,
      synthModel,
      'T',
      'x',
      (input) => ({ ...input, note: '変更後note' }),
      { expectPreserved: ['unique', '// 行末コメントは触らない', 'pk', 'not null'] },
    );
    runCase(
      'increment温存(型変更)',
      synthSrc,
      synthModel,
      'T',
      'y',
      (input) => ({ ...input, type: 'bigint' }),
      { expectPreserved: ['increment', 'default: 0'] },
    );
    runCase(
      'インラインref温存(not null OFF)',
      synthSrc,
      synthModel,
      'T',
      'z',
      (input) => ({ ...input, notNull: false }),
      { expectPreserved: ['ref: > U.id'] },
    );
    runCase(
      '属性全削除で[]ごと消える',
      synthSrc,
      synthModel,
      'U',
      'id',
      (input) => ({ ...input, pk: false }),
    );
  }
}

// ---------------------------------------------------------------
// 全カラム no-op スイープ: 全テーブル×全カラムを「無変更で確定」し、
// 1件でも changed:true になったら書式保持違反(過去に複合PK・空文字defaultで実際に発生)。
// ---------------------------------------------------------------
console.log('\n--- 全カラム no-op スイープ(無変更確定でファイルが1文字も変わらないこと) ---');
{
  let sweepFail = 0;
  let sweepTotal = 0;
  for (const table of model.tables) {
    for (const col of table.columns) {
      sweepTotal++;
      try {
        const { changed, newLine } = replaceColumnLine(src, table, col, toInput(col));
        if (changed) {
          sweepFail++;
          if (sweepFail <= 10) {
            console.log(`  [FAIL] ${table.name}.${col.name}: 無変更確定なのに changed=true -> "${newLine.trim()}"`);
          }
        }
      } catch (err) {
        sweepFail++;
        if (sweepFail <= 10) {
          console.log(`  [FAIL] ${table.name}.${col.name}: 例外: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  if (sweepFail === 0) {
    console.log(`  [OK] 全 ${sweepTotal} カラムで changed=false(ファイル不変)`);
  } else {
    console.log(`  [FAIL] ${sweepFail}/${sweepTotal} カラムで無変更確定が差分を生む`);
    failCount += sweepFail;
  }
}

console.log(`\n=== 結果: ${failCount === 0 ? '全ケースOK' : `${failCount}件FAIL`} ===`);
process.exit(failCount === 0 ? 0 : 1);
