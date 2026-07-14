// @dbml/core のラッパ。DBML テキストをパースし、アプリ内部モデル(DbmlModel)へ変換する。
import { Parser } from '@dbml/core';
import { perfSpan } from '../perf/perf.ts';
import type { Database, Table, Field, Ref, Enum, Token } from '@dbml/core';
import type {
  DbmlTable,
  DbmlColumn,
  DbmlRef,
  DbmlRefEndpoint,
  DbmlEnum,
  RefMultiplicity,
  TokenRange,
  DbmlParseResult,
  DbmlParseError,
} from './model';

function toTokenRange(token: Token | undefined | null): TokenRange | undefined {
  if (!token) return undefined;
  return {
    start: { line: token.start.line, column: token.start.column, offset: token.start.offset },
    end: { line: token.end.line, column: token.end.column, offset: token.end.offset },
  };
}

function tableId(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

function columnId(schemaName: string, tableName: string, columnName: string): string {
  return `${schemaName}.${tableName}.${columnName}`;
}

function relationToMultiplicity(rel0: '1' | '*', rel1: '1' | '*'): RefMultiplicity {
  if (rel0 === '1' && rel1 === '1') return '1:1';
  if (rel0 === '1' && rel1 === '*') return '1:N';
  if (rel0 === '*' && rel1 === '1') return 'N:1';
  return 'N:N';
}

/**
 * default値をアプリ内表現(文字列)に変換する。
 * 式(expression)は編集UIとの往復で意味が変わらないよう、DBMLの式表記(バッククォート付き)で保持する
 * (例: `SYSDATETIME()`)。文字列・数値は値そのまま。
 */
function convertDbDefault(dbdefault: Field['dbdefault']): string | undefined {
  if (dbdefault == null) return undefined;
  if (typeof dbdefault === 'object') {
    const value = String(dbdefault.value ?? '');
    if ((dbdefault as { type?: string }).type === 'expression') {
      return `\`${value}\``;
    }
    return value;
  }
  return String(dbdefault);
}

function convertField(
  field: Field,
  schemaName: string,
  tableName: string,
  fkColumnNames: Set<string>,
  compositePkColumnNames: Set<string>,
): DbmlColumn {
  // field.type.type_name は enum 以外の通常の型でも常にセットされるため、
  // enum 参照かどうかは field._enum (実際に bind された Enum インスタンス) の有無で判定する。
  const enumName = field._enum?.name;

  return {
    id: columnId(schemaName, tableName, field.name),
    name: field.name,
    type: typeof field.type === 'object' && field.type !== null && 'type_name' in field.type
      ? String((field.type as { type_name?: string }).type_name ?? '')
      : String(field.type ?? ''),
    // 複合PK: @dbml/core は複数カラムに pk が付くと複合PKインデックスへ正規化し、
    // 各 field.pk を落とす。表示・編集プリフィルが実態(元テキストの pk 属性)と
    // 食い違わないよう、複合PKインデックスのメンバーも pk=true として扱う。
    pk: !!field.pk || compositePkColumnNames.has(field.name),
    notNull: !!field.not_null,
    unique: !!field.unique,
    isForeignKey: fkColumnNames.has(field.name),
    increment: !!field.increment,
    dbdefault: convertDbDefault(field.dbdefault),
    note: field.note || undefined,
    enumName: enumName || undefined,
    token: toTokenRange(field.token),
  };
}

function convertTable(table: Table, fkColumnsByTable: Map<string, Set<string>>): DbmlTable {
  const schemaName = table.schema?.name ?? 'public';
  const fkColumnNames = fkColumnsByTable.get(tableId(schemaName, table.name)) ?? new Set<string>();

  // 複合PKインデックス(pk: true)のメンバーカラム名を集める。
  const compositePkColumnNames = new Set<string>();
  for (const index of table.indexes ?? []) {
    if (!index.pk) continue;
    for (const col of index.columns ?? []) {
      if (col.value != null) compositePkColumnNames.add(String(col.value));
    }
  }

  return {
    id: tableId(schemaName, table.name),
    name: table.name,
    schema: schemaName,
    alias: table.alias || undefined,
    note: table.note || undefined,
    columns: table.fields.map((f) => convertField(f, schemaName, table.name, fkColumnNames, compositePkColumnNames)),
    token: toTokenRange(table.token),
  };
}

function convertRef(ref: Ref): DbmlRef | undefined {
  if (ref.endpoints.length < 2) return undefined;
  const [e0, e1] = ref.endpoints;
  const ep0: DbmlRefEndpoint = {
    tableId: tableId(e0.schemaName || 'public', e0.tableName),
    tableName: e0.tableName,
    schema: e0.schemaName || 'public',
    columnNames: e0.fieldNames,
    relation: e0.relation,
  };
  const ep1: DbmlRefEndpoint = {
    tableId: tableId(e1.schemaName || 'public', e1.tableName),
    tableName: e1.tableName,
    schema: e1.schemaName || 'public',
    columnNames: e1.fieldNames,
    relation: e1.relation,
  };

  return {
    id: `ref.${ep0.tableId}.${ep0.columnNames.join(',')}__${ep1.tableId}.${ep1.columnNames.join(',')}`,
    name: ref.name || undefined,
    endpoints: [ep0, ep1],
    multiplicity: relationToMultiplicity(ep0.relation, ep1.relation),
    token: toTokenRange(ref.token),
  };
}

function convertEnum(en: Enum): DbmlEnum {
  const schemaName = en.schema?.name ?? 'public';
  return {
    id: `${schemaName}.${en.name}`,
    name: en.name,
    schema: schemaName,
    values: en.values.map((v) => ({ name: v.name, note: v.note || undefined })),
    token: toTokenRange(en.token),
  };
}

/** Database 全体から、外部キー(Refのエンドポイントに登場するカラム)を集計する。 */
function collectForeignKeyColumns(database: Database): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const schema of database.schemas) {
    for (const ref of schema.refs) {
      for (const ep of ref.endpoints) {
        // '*' 側(多側)が実務上の外部キーカラムであることが多いが、
        // '1' 側も含め両エンドポイントとも「関係に登場するカラム」として FK 表示対象とする。
        const key = tableId(ep.schemaName || 'public', ep.tableName);
        if (!map.has(key)) map.set(key, new Set());
        for (const fieldName of ep.fieldNames) {
          map.get(key)!.add(fieldName);
        }
      }
    }
  }
  return map;
}

function extractErrorInfo(err: unknown): DbmlParseError {
  // @dbml/core のパースエラーは { diags: CompilerDiagnostic[] } 形式で投げられる。
  if (err && typeof err === 'object' && 'diags' in err) {
    const diags = (err as { diags?: Array<{ message?: string; location?: { start?: { line?: number; column?: number } } }> }).diags;
    const first = diags?.[0];
    if (first) {
      return {
        message: first.message ?? 'DBML の解析に失敗しました。',
        line: first.location?.start?.line,
        column: first.location?.start?.column,
      };
    }
  }
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: String(err) };
}

/** DBML テキストをパースし、内部モデルへ変換する。失敗時はエラー情報を返す(例外は投げない)。 */
export function parseDbml(source: string): DbmlParseResult {
  try {
    // @dbml/core 本体のパース(構文解析)と、内部モデルへの変換を分けて計測する。
    // どちらが重いかで最適化の当て先が変わるため(パーサ側は差し替え不可、変換側は自前で改善可)。
    const database = perfSpan('1|parse:@dbml/core', () => {
      const parser = new Parser();
      return parser.parse(source, 'dbml');
    });

    const model = perfSpan(
      '2|parse:model変換',
      () => {
        const fkColumnsByTable = collectForeignKeyColumns(database);

        const tables: DbmlTable[] = [];
        const refs: DbmlRef[] = [];
        const enums: DbmlEnum[] = [];

        for (const schema of database.schemas) {
          for (const table of schema.tables) {
            tables.push(convertTable(table, fkColumnsByTable));
          }
          for (const ref of schema.refs) {
            const converted = convertRef(ref);
            if (converted) refs.push(converted);
          }
          for (const en of schema.enums) {
            enums.push(convertEnum(en));
          }
        }

        return { tables, refs, enums };
      },
      (m) => `${m.tables.length}表 / ${m.refs.length}参照`,
    );

    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: extractErrorInfo(err) };
  }
}
