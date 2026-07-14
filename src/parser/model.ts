// JPDBMLEditor 内部モデル型定義。
// @dbml/core の生パース結果から変換した、アプリ内で扱いやすい形。
//
// 重要（フェーズ4への布石）: token フィールドは元テキスト上の位置情報(レンジ)を保持する。
// spike (Docs/spike-位置情報.md) の結果、@dbml/core の Table/Field/Ref はいずれも
// トークンレンジ(行/列/オフセット)を持つことを確認済み。取れない場合は undefined。

/** 元テキスト上の1点の位置(1始まりの行・列 / 0始まりのオフセット)。 */
export interface DbmlPosition {
  line: number;
  column: number;
  offset: number;
}

/** 元テキスト上のレンジ(トークン開始〜終了)。 */
export interface TokenRange {
  start: DbmlPosition;
  end: DbmlPosition;
}

/** カラム(フィールド)の内部モデル。 */
export interface DbmlColumn {
  /** アプリ内で一意なID(スキーマ名.テーブル名.カラム名 から生成)。 */
  id: string;
  name: string;
  /** DBML上の型表記(例: "varchar(30)", "int")。 */
  type: string;
  pk: boolean;
  notNull: boolean;
  unique: boolean;
  /** このカラムが何らかの Ref の endpoint に登場し、外部キーとみなせるか。 */
  isForeignKey: boolean;
  increment: boolean;
  dbdefault?: string;
  note?: string;
  /** 型が Enum を参照している場合、その Enum 名。 */
  enumName?: string;
  /** フェーズ4用: 元テキスト上のこのカラム定義行のレンジ。 */
  token?: TokenRange;
}

/** テーブルの内部モデル。 */
export interface DbmlTable {
  /** アプリ内で一意なID(スキーマ名.テーブル名 から生成)。 */
  id: string;
  name: string;
  schema: string;
  alias?: string;
  note?: string;
  columns: DbmlColumn[];
  /** フェーズ4用: 元テキスト上のこのテーブル定義ブロックのレンジ。 */
  token?: TokenRange;
}

export type RefMultiplicity = '1:1' | '1:N' | 'N:1' | 'N:N';

export interface DbmlRefEndpoint {
  tableId: string;
  tableName: string;
  schema: string;
  columnNames: string[];
  /** '1' (one) か '*' (many) か。 */
  relation: '1' | '*';
}

/** リレーション(Ref)の内部モデル。 */
export interface DbmlRef {
  id: string;
  name?: string;
  /** endpoints[0] -> endpoints[1] の向き。 */
  endpoints: [DbmlRefEndpoint, DbmlRefEndpoint];
  multiplicity: RefMultiplicity;
  /** フェーズ4用: 元テキスト上のこの Ref 定義行のレンジ。 */
  token?: TokenRange;
}

export interface DbmlEnumValue {
  name: string;
  note?: string;
}

export interface DbmlEnum {
  id: string;
  name: string;
  schema: string;
  values: DbmlEnumValue[];
  token?: TokenRange;
}

/** パース結果全体の内部モデル。 */
export interface DbmlModel {
  tables: DbmlTable[];
  refs: DbmlRef[];
  enums: DbmlEnum[];
}

export interface DbmlParseError {
  message: string;
  line?: number;
  column?: number;
}

export type DbmlParseResult =
  | { ok: true; model: DbmlModel }
  | { ok: false; error: DbmlParseError };
