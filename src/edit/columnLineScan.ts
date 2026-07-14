// カラム定義行の軽量パース・走査ロジック(純関数)。
// replaceColumnLine.ts / deleteColumn.ts / moveColumn.ts が共通で使う
// 「行の構造を壊さずに読み取る」基盤をここに集約する。
//
// 行の想定構造:
//   <indent><名前トークン> <型> [<属性リスト>] <行末コメント等>
// - 名前: `"..."` (エスケープあり) または非空白トークン
// - 型: `nvarchar(100)` のような括弧付きに対応(括弧内のカンマ・空白は型の一部)
// - 属性リスト: クォート('、"、`)内のカンマ/角括弧を無視してトップレベルで分割
// - 行末: `]` より後ろ(または属性が無ければ型より後ろ)を無条件で温存
import type { DbmlColumn } from '../parser/model';

/** 行パース結果。生テキストの断片をそのまま保持する(温存のため)。 */
interface ParsedColumnLine {
  indent: string;
  /** 名前トークンの生テキスト(クォート込み)。 */
  nameRaw: string;
  /** 名前と型の間の空白(元のまま)。 */
  wsAfterName: string;
  /** 型の生テキスト。 */
  typeRaw: string;
  /** 型と `[` の間の空白(属性が無ければ空文字)。 */
  wsBeforeAttrs: string;
  /** 属性リスト(トップレベルカンマで分割済み、各要素はtrim済みの生テキスト)。属性ブロックが無ければ null。 */
  attrs: string[] | null;
  /** `]` より後ろ(属性が無ければ型より後ろ)の残り全部(行末コメント等)。 */
  suffix: string;
}

/** クォート文字か。DBMLで文字列を囲むのは ' " ` の3種。 */
function isQuoteChar(ch: string): boolean {
  return ch === "'" || ch === '"' || ch === '`';
}

/**
 * カラム定義行を軽量パースする。想定外の構造(名前が見つからない等)なら null。
 */
export function parseColumnDefLine(line: string): ParsedColumnLine | null {
  const indentMatch = /^[ \t]*/.exec(line);
  const indent = indentMatch ? indentMatch[0] : '';
  let i = indent.length;
  if (i >= line.length) return null;

  // --- 名前トークン ---
  let nameRaw: string;
  if (line[i] === '"') {
    // ダブルクォート名: エスケープ(\")を考慮して閉じクォートまで
    let j = i + 1;
    while (j < line.length) {
      if (line[j] === '\\') {
        j += 2;
        continue;
      }
      if (line[j] === '"') break;
      j++;
    }
    if (j >= line.length) return null; // 閉じクォートなし
    nameRaw = line.slice(i, j + 1);
    i = j + 1;
  } else {
    // 非クォート名: 空白まで
    let j = i;
    while (j < line.length && !/\s/.test(line[j])) j++;
    if (j === i) return null;
    nameRaw = line.slice(i, j);
    i = j;
  }

  // --- 名前と型の間の空白 ---
  let j = i;
  while (j < line.length && /[ \t]/.test(line[j])) j++;
  const wsAfterName = line.slice(i, j);
  i = j;
  if (i >= line.length) return null; // 型が無い

  // --- 型: `[`(トップレベル) / `//`(トップレベル) / 行末 まで ---
  let parenDepth = 0;
  let quote: string | null = null;
  j = i;
  while (j < line.length) {
    const ch = line[j];
    if (quote) {
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === quote) quote = null;
      j++;
      continue;
    }
    if (isQuoteChar(ch)) {
      quote = ch;
      j++;
      continue;
    }
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (parenDepth === 0 && ch === '[') break;
    else if (parenDepth === 0 && ch === '/' && line[j + 1] === '/') break;
    j++;
  }
  // 型の末尾の空白は wsBeforeAttrs / suffix 側に回す
  let typeEnd = j;
  while (typeEnd > i && /[ \t]/.test(line[typeEnd - 1])) typeEnd--;
  const typeRaw = line.slice(i, typeEnd);
  if (typeRaw.length === 0) return null;

  if (j < line.length && line[j] === '[') {
    // --- 属性ブロック ---
    const wsBeforeAttrs = line.slice(typeEnd, j);
    // `]` をクォート考慮で探す
    let k = j + 1;
    let q: string | null = null;
    while (k < line.length) {
      const ch = line[k];
      if (q) {
        if (ch === '\\') {
          k += 2;
          continue;
        }
        if (ch === q) q = null;
        k++;
        continue;
      }
      if (isQuoteChar(ch)) {
        q = ch;
        k++;
        continue;
      }
      if (ch === ']') break;
      k++;
    }
    if (k >= line.length) return null; // 閉じ `]` なし
    const attrsContent = line.slice(j + 1, k);
    const suffix = line.slice(k + 1);

    // トップレベルカンマで分割(クォート・括弧内は無視)
    const attrs: string[] = [];
    let start = 0;
    let depth = 0;
    let q2: string | null = null;
    for (let m = 0; m < attrsContent.length; m++) {
      const ch = attrsContent[m];
      if (q2) {
        if (ch === '\\') {
          m++;
          continue;
        }
        if (ch === q2) q2 = null;
        continue;
      }
      if (isQuoteChar(ch)) {
        q2 = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        attrs.push(attrsContent.slice(start, m).trim());
        start = m + 1;
      }
    }
    const last = attrsContent.slice(start).trim();
    if (last.length > 0) attrs.push(last);

    return { indent, nameRaw, wsAfterName, typeRaw, wsBeforeAttrs, attrs, suffix };
  }

  // 属性ブロックなし: 型より後ろは全部 suffix(行末コメント等)
  return { indent, nameRaw, wsAfterName, typeRaw, wsBeforeAttrs: '', attrs: null, suffix: line.slice(typeEnd) };
}

/** クォート名トークン(`"..."`)から名前を復元する(エスケープ解除)。非クォートはそのまま。 */
export function unquoteName(nameRaw: string): string {
  if (nameRaw.startsWith('"') && nameRaw.endsWith('"') && nameRaw.length >= 2) {
    return nameRaw.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return nameRaw;
}

/** findColumnDefLine の戻り値(行番号は1始まり)。 */
export interface FoundColumnDefLine {
  lineNumber: number;
  originalLine: string;
  parsed: NonNullable<ReturnType<typeof parseColumnDefLine>>;
}

/**
 * テーブル定義テキスト中から、指定カラムの「定義行」を特定する(replaceColumnLine/deleteColumnLine 共通)。
 *
 * 通常は token.start.line がカラム定義行だが、カラムの直前に独自コメント行(// ...)があると
 * token.start.line はコメント行を指す(insertColumn.ts 冒頭の既知の制限と同根)。そのため
 * token の行範囲内を前方走査し、パースした名前が対象カラムと一致する行を採用する。
 *
 * @param lines sourceText を改行で分割した配列
 * @param column 対象カラム(token情報が必須)
 * @returns 見つかれば行情報、見つからなければ null
 */
export function findColumnDefLine(lines: string[], column: DbmlColumn): FoundColumnDefLine | null {
  if (!column.token) return null;
  const scanStart = column.token.start.line;
  const scanEnd = Math.max(scanStart, column.token.end.line);
  for (let n = scanStart; n <= scanEnd && n <= lines.length; n++) {
    const candidate = lines[n - 1];
    if (candidate === undefined) break;
    const p = parseColumnDefLine(candidate);
    if (p && unquoteName(p.nameRaw) === column.name) {
      return { lineNumber: n, originalLine: candidate, parsed: p };
    }
  }
  return null;
}
