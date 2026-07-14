// DBML の1カラム定義行を組み立てる純関数群。
// SampleDBML の実データを観察した結果、カラム名は例外なく
// ダブルクォートで囲まれている(日本語名がほとんどのため)。この流儀に合わせ、
// 本アプリが生成する行も常にカラム名をダブルクォートで囲む。

export interface ColumnInput {
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
  /** default値の生入力(空文字/未指定なら省略)。 */
  defaultValue?: string;
  /** note の生入力(空文字/未指定なら省略)。改行はそのまま\nとして扱う。 */
  note?: string;
}

/**
 * 1行に収めるべき値から改行を除去する(ペースト等で改行が混入した場合の防御)。
 * カラム名・型は「1カラム=1行」という最小編集の前提を壊すため、改行は空白に置換する。
 */
function stripNewlines(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ').trim();
}

/** カラム名をダブルクォートで囲む。内部のダブルクォートはエスケープする。 */
export function formatColumnName(name: string): string {
  const escaped = stripNewlines(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * default値の表記を判定して整形する。
 * - 数値(整数/小数、符号可)はそのまま(クォートなし)。
 * - バッククォートで囲まれている入力はDBMLの式表記(例: `SYSDATETIME()`)としてそのまま使う。
 * - true/false/null もそのまま(予約語表記)。
 * - それ以外は文字列表記としてシングルクォートで囲む(内部の ' はエスケープ)。
 */
export function formatDefaultValue(raw: string): string {
  const trimmed = stripNewlines(raw);
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed;
  }
  if (/^(true|false|null)$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return `'${escapeNoteString(trimmed)}'`;
}

/** note文字列内のシングルクォートをエスケープし、改行は\nリテラルに変換する。 */
export function escapeNoteString(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * note の「UI入力表記」→「DBMLソース上のシングルクォート内の生表記」変換。
 * UI入力表記の約束: 改行は実改行で表す(ColumnEditRow の note は複数行テキストエリアで、
 * Excel と同じ Alt/Option+Enter によりセル内改行を入力する)。
 * シングルクォートは素のまま書いてよい(こちらでエスケープする)。
 * - 実改行はDBML表記のリテラル `\n` に変換する(既存データの流儀と一致)。
 * - エスケープされていないシングルクォートのみ `\'` にする(既に `\'` のものは二重にしない)。
 * - それ以外のバックスラッシュ(手打ちのリテラル `\n` を含む)はそのまま通す。
 *   これにより既存noteのプリフィル(noteToInput)を無編集で確定しても表記が変わらない(往復一致)。
 */
export function noteFromInput(input: string): string {
  return input
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\\'|'/g, (m) => (m === "'" ? "\\'" : m));
}

/**
 * note の「内部モデル表記」→「UI入力表記(実改行)」変換(編集プリフィル用)。
 *
 * 重要: `@dbml/core` は note 内の `\n` をエスケープとして解釈せず、バックスラッシュ+n の
 * 2文字のまま内部モデルに入れる(SampleDBML の実データで確認済み)。つまり内部モデルの note の
 * 「改行」はリテラル `\n` として現れる。UI(複数行テキストエリア)では実改行で見せたいので、
 * ここでリテラル `\n` を実改行に開く。
 *
 * noteFromInput が実改行をリテラル `\n` に戻すため、無編集の確定で表記は変わらない(往復一致)。
 * クォートやバックスラッシュはそのまま見せる。
 */
export function noteToInput(note: string): string {
  return note.replace(/\r\n|\r/g, '\n').replace(/\\n/g, '\n');
}

/**
 * カラム属性([pk, not null, default: X, note: 'Y'] 部分)を組み立てる。
 * 属性が1つもなければ空文字(呼び出し側で[]ごと省略する)。
 * note は UI入力表記(noteFromInput の約束)として解釈する。リテラル `\n` は
 * DBMLの改行表記としてそのまま残る(既存データの流儀と一致)。
 */
export function formatColumnAttrs(input: ColumnInput): string {
  const attrs: string[] = [];
  if (input.pk) attrs.push('pk');
  if (input.notNull) attrs.push('not null');
  if (input.defaultValue && input.defaultValue.trim().length > 0) {
    attrs.push(`default: ${formatDefaultValue(input.defaultValue)}`);
  }
  if (input.note && input.note.trim().length > 0) {
    attrs.push(`note: '${noteFromInput(input.note)}'`);
  }
  if (attrs.length === 0) return '';
  return ` [${attrs.join(', ')}]`;
}

/**
 * カラム定義1行分のテキストを組み立てる(インデントは呼び出し側=insertColumn.tsで付与)。
 * 例: `"created_at" timestamp [not null, default: \`SYSDATETIME()\`, note: '作成日時']`
 */
export function formatColumnLine(input: ColumnInput): string {
  const name = formatColumnName(input.name);
  const type = stripNewlines(input.type);
  const attrs = formatColumnAttrs(input);
  return `${name} ${type}${attrs}`;
}
