// 既存カラム定義行の最小編集(置換)ロジック(純関数)。
//
// 原則: 行を丸ごと再生成しない。UI が扱わない属性(unique, increment, インライン ref: 等)や
// 行末 `// コメント`、元のインデント・クォート表記を温存するため、行を軽量パースして
// 「UI が管理する部分(名前/型/pk/not null/default/note)」だけをテキストレベルでマージする。
//
// 行の想定構造:
//   <indent><名前トークン> <型> [<属性リスト>] <行末コメント等>
// - 名前: `"..."` (エスケープあり) または非空白トークン
// - 型: `nvarchar(100)` のような括弧付きに対応(括弧内のカンマ・空白は型の一部)
// - 属性リスト: クォート('、"、`)内のカンマ/角括弧を無視してトップレベルで分割
// - 行末: `]` より後ろ(または属性が無ければ型より後ろ)を無条件で温存
//
// 未変更検出: 各フィールドを「元の行から読み取った値」と意味比較し、変わっていない
// フィールドは元の生テキストをそのまま残す(スペーシング・クォート流儀・バッククォート
// 式表記などを壊さない)。全フィールド未変更なら changed:false を返し、呼び出し側は
// ファイル書き込みをスキップできる。
import type { DbmlColumn, DbmlTable } from '../parser/model';
import {
  formatColumnName,
  formatDefaultValue,
  noteFromInput,
  noteToInput,
  type ColumnInput,
} from './lineFormat.ts';
import { findColumnDefLine } from './columnLineScan.ts';
import { assertColumnToken, splitSourceLines, throwColumnDefLineNotFound } from './sourceLines.ts';

export interface ReplaceColumnResult {
  /** 置換後の全文(changed=false のときは sourceText と同一)。 */
  newText: string;
  /** 置換後の行の内容(インデント込み)。 */
  newLine: string;
  /** 実際に変更があったか(false ならファイル書き込み不要)。 */
  changed: boolean;
  /** 対象行番号(1始まり)。 */
  lineNumber: number;
}

/** default属性の値部分(生)からクォート/バッククォートを剥がした意味値を得る(未変更比較用)。 */
function unquoteDefaultValue(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"') || (first === '`' && last === '`')) {
      return t.slice(1, -1).replace(/\\(.)/g, '$1');
    }
  }
  return t;
}

/** note属性の値部分(生)からクォートの中身(生表記のまま=エスケープ解除しない)を取り出す。 */
function extractNoteRawContent(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/** 属性の種類判定。 */
type AttrKind = 'pk' | 'notNull' | 'default' | 'note' | 'other';

function classifyAttr(attr: string): AttrKind {
  if (/^pk$/i.test(attr) || /^primary\s+key$/i.test(attr)) return 'pk';
  if (/^not\s+null$/i.test(attr)) return 'notNull';
  if (/^default\s*:/i.test(attr)) return 'default';
  if (/^note\s*:/i.test(attr)) return 'note';
  return 'other';
}

/** `default: X` / `note: 'X'` から値部分を取り出す。 */
function attrValuePart(attr: string): string {
  const idx = attr.indexOf(':');
  return idx === -1 ? '' : attr.slice(idx + 1).trim();
}

/**
 * 既存カラム定義行を newDef の内容でテキストレベルにマージ置換する。
 *
 * @param sourceText 現在のDBML全文
 * @param table 対象テーブル(token情報つき。エラーメッセージ用)
 * @param column 対象カラム(token情報が必須)
 * @param newDef 編集後の値(UI入力表記。note は noteFromInput の約束、default は生入力)
 */
export function replaceColumnLine(
  sourceText: string,
  table: DbmlTable,
  column: DbmlColumn,
  newDef: ColumnInput,
): ReplaceColumnResult {
  assertColumnToken(column);

  const { eol, lines } = splitSourceLines(sourceText);

  // 対象行の特定は findColumnDefLine に集約(deleteColumnLine と共通)。
  const found = findColumnDefLine(lines, column);
  if (!found) {
    throwColumnDefLineNotFound(table, column, '編集');
  }
  const { lineNumber, originalLine, parsed } = found;

  // --- 名前: 未変更なら生トークン温存(元のクォート流儀を保つ) ---
  const newName = newDef.name.trim();
  const nameToken = newName === column.name ? parsed.nameRaw : formatColumnName(newName);

  // --- 型: 生テキスト or モデル値のどちらかに一致すれば未変更扱い ---
  const newType = newDef.type.trim();
  const typeToken =
    newType === parsed.typeRaw || newType === column.type ? parsed.typeRaw : newType.replace(/\s+/g, ' ');

  // --- 属性マージ: 元の順序を保ちつつ UI 管理キーのみ更新。other は無条件温存 ---
  //
  // 重要: 各フィールドは「ユーザーがプリフィルから実際に変更したか(touched)」で判定し、
  // 変更していないフィールドは元の生テキストを無条件で温存する。
  // これは「UI入力と行の実体の比較」では守れないケースがあるため:
  // - 複合PK: @dbml/core は複数pkを複合PKインデックスへ正規化するが、明示的な
  //   indexes ブロック由来の複合PKでは行に pk 属性が無い。モデル値(プリフィル元)との
  //   比較でなければ「無変更確定」の意図を正しく検出できない。
  // - 空文字 default (`default: ''`): プリフィルは「defaultなし」と同じ空文字になるため、
  //   実体と比較すると無変更確定で default が消えてしまう。
  const originalAttrs = parsed.attrs ?? [];
  const merged: string[] = [];
  let sawPk = false;
  let sawNotNull = false;
  let sawDefault = false;
  let sawNote = false;

  const wantDefault = (newDef.defaultValue ?? '').trim();
  const wantNoteRaw = (newDef.note ?? '').trim().length > 0 ? noteFromInput(newDef.note!.trim()) : '';

  // プリフィル元(モデル値)との比較による「ユーザー変更」検出。
  // プリフィル変換(TableNode.toEditInitialValues)と対称になっていること:
  //   pk/notNull ← column.pk / column.notNull
  //   default    ← column.dbdefault ?? ''
  //   note       ← noteToInput(column.note ?? '')
  const pkTouched = newDef.pk !== column.pk;
  const notNullTouched = newDef.notNull !== column.notNull;
  const defaultTouched = wantDefault !== (column.dbdefault ?? '').trim();
  const noteTouched = (newDef.note ?? '').trim() !== (column.note ? noteToInput(column.note) : '').trim();

  for (const attr of originalAttrs) {
    const kind = classifyAttr(attr);
    switch (kind) {
      case 'pk':
        sawPk = true;
        if (!pkTouched || newDef.pk) merged.push(attr); // 未変更 or ON: 表記(pk/primary key)温存
        break;
      case 'notNull':
        sawNotNull = true;
        if (!notNullTouched || newDef.notNull) merged.push(attr);
        break;
      case 'default': {
        sawDefault = true;
        if (!defaultTouched) {
          merged.push(attr); // 未変更: 生表記温存(バッククォート式・空文字defaultなど)
          break;
        }
        if (wantDefault.length === 0) break; // 削除
        const currentValue = unquoteDefaultValue(attrValuePart(attr));
        if (wantDefault === currentValue || wantDefault === attrValuePart(attr)) {
          merged.push(attr); // 表記まで同一: 生表記温存
        } else {
          merged.push(`default: ${formatDefaultValue(wantDefault)}`);
        }
        break;
      }
      case 'note': {
        sawNote = true;
        if (!noteTouched) {
          merged.push(attr); // 未変更: 生表記温存
          break;
        }
        if (wantNoteRaw.length === 0) break; // 削除
        const currentRaw = extractNoteRawContent(attrValuePart(attr));
        if (wantNoteRaw === currentRaw) {
          merged.push(attr);
        } else {
          merged.push(`note: '${wantNoteRaw}'`);
        }
        break;
      }
      case 'other':
        merged.push(attr); // unique / increment / ref: 等は無条件温存
        break;
    }
  }

  // 元に無かった UI 管理属性の新規追加(末尾に付ける)。ユーザーが変更した場合のみ。
  // (複合PKインデックス由来で行に pk 属性が無いカラムに、無変更確定で pk を足さないため)
  if (pkTouched && newDef.pk && !sawPk) merged.push('pk');
  if (notNullTouched && newDef.notNull && !sawNotNull) merged.push('not null');
  if (defaultTouched && wantDefault.length > 0 && !sawDefault) merged.push(`default: ${formatDefaultValue(wantDefault)}`);
  if (noteTouched && wantNoteRaw.length > 0 && !sawNote) merged.push(`note: '${wantNoteRaw}'`);

  // --- 行の再構築 ---
  let attrsPart: string;
  if (merged.length === 0) {
    attrsPart = ''; // 属性が全滅したら [] ごと削除
  } else if (parsed.attrs !== null) {
    attrsPart = `${parsed.wsBeforeAttrs}[${merged.join(', ')}]`; // 元の `[` 前スペーシング踏襲
  } else {
    attrsPart = ` [${merged.join(', ')}]`; // 新設
  }

  const newLine = `${parsed.indent}${nameToken}${parsed.wsAfterName}${typeToken}${attrsPart}${parsed.suffix}`;

  if (newLine === originalLine) {
    return { newText: sourceText, newLine, changed: false, lineNumber };
  }

  const newLines = [...lines];
  newLines[lineNumber - 1] = newLine;
  return { newText: newLines.join(eol), newLine, changed: true, lineNumber };
}
