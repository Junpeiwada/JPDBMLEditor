// .jpdbml.json サイドカー(見た目状態の永続化)の読み書き。
// 設計原則3: サイドカーは「あれば使う」補助情報。無い/壊れている場合は必ず null を返し、
// 呼び出し側は自動レイアウトにフォールバックする(.dbml 本体には見た目状態を一切書かない)。
//
// 現時点で保存するのはテーブル配置座標・テーブル幅・カラム列幅。将来はホップ数・色分け・
// 折りたたみ状態などをここに足していく(version で移行を吸収できるようにしておく)。
import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';

/** サイドカーのスキーマバージョン(将来の移行判定用)。 */
export const SIDECAR_VERSION = 1 as const;

/** テーブル1つの配置座標(React Flow のノード座標系)。 */
export interface TablePosition {
  x: number;
  y: number;
}

/** サイドカー(.jpdbml.json)の内容。 */
export interface SidecarData {
  version: number;
  /** テーブルID → 配置座標。ユーザーが動かしたテーブルのみ載る(未移動は自動レイアウトに委ねる)。 */
  tablePositions: Record<string, TablePosition>;
  /**
   * テーブルID → テーブル幅(px)。箱の直接リサイズ廃止(2026-07-14)により新規書き込みは
   * 行わない(常に空マップを書く)。読み込みは旧ファイルとの後方互換のため残す。
   * 正の有限数のみ有効。
   */
  tableWidths: Record<string, number>;
  /**
   * テーブルID → カラム行の列幅(px)。Excel風リサイズのため名前列も含む全列を絶対pxで持つ
   * (手動リサイズした列のみ)。未指定の列は文字数からの自動概算に委ねる。正の有限数のみ有効。
   */
  columnWidths: Record<string, TableColumnWidthOverride>;
}

/** テーブル1つのカラム行の列幅上書き(手動リサイズ分。未指定=自動概算に委ねる)。 */
export interface TableColumnWidthOverride {
  /** 名前列の幅(px)。 */
  name?: number;
  /** 型列の幅(px)。 */
  type?: number;
  /** note列の幅(px)。 */
  note?: number;
}

/**
 * `.dbml` のパスから、隣に併置するサイドカー `.jpdbml.json` のパスを導出する。
 * 拡張子 `.dbml` を `.jpdbml.json` に置き換える(大文字小文字は元の拡張子表記を尊重せず小文字前提。
 * DBMLの慣習上 `.dbml` 小文字で扱う)。`.dbml` で終わらない場合は末尾に付け足す(防御的)。
 */
export function sidecarPathFor(dbmlPath: string): string {
  if (dbmlPath.toLowerCase().endsWith('.dbml')) {
    return `${dbmlPath.slice(0, -'.dbml'.length)}.jpdbml.json`;
  }
  return `${dbmlPath}.jpdbml.json`;
}

/** 値が有限数かどうか(JSON由来のNaN/Infinity/文字列混入を弾く)。 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * サイドカーを読み込む。存在しない・JSONが壊れている・スキーマが想定外の場合は null を返す
 * (呼び出し側は null を「自動レイアウトにフォールバック」として扱う)。
 * 座標マップは、数値ペアとして妥当なエントリだけを取り込む(壊れた1エントリで全体を捨てない)。
 */
export async function readSidecar(dbmlPath: string): Promise<SidecarData | null> {
  const path = sidecarPathFor(dbmlPath);
  try {
    if (!(await exists(path))) return null;
    const text = await readTextFile(path);
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;

    const obj = raw as Record<string, unknown>;
    const positionsRaw = obj.tablePositions;
    const tablePositions: Record<string, TablePosition> = {};
    if (typeof positionsRaw === 'object' && positionsRaw !== null) {
      for (const [id, pos] of Object.entries(positionsRaw as Record<string, unknown>)) {
        if (typeof pos !== 'object' || pos === null) continue;
        const { x, y } = pos as Record<string, unknown>;
        if (isFiniteNumber(x) && isFiniteNumber(y)) {
          tablePositions[id] = { x, y };
        }
      }
    }

    // 手動リサイズ幅。正の有限数のみ取り込む(0/負/文字列混入は無視して自動概算に委ねる)。
    const widthsRaw = obj.tableWidths;
    const tableWidths: Record<string, number> = {};
    if (typeof widthsRaw === 'object' && widthsRaw !== null) {
      for (const [id, w] of Object.entries(widthsRaw as Record<string, unknown>)) {
        if (isFiniteNumber(w) && w > 0) {
          tableWidths[id] = w;
        }
      }
    }

    // カラム列幅(型/note)。正の有限数のエントリだけ取り込む。壊れた列は無視して自動概算に委ねる。
    const colWidthsRaw = obj.columnWidths;
    const columnWidths: Record<string, TableColumnWidthOverride> = {};
    if (typeof colWidthsRaw === 'object' && colWidthsRaw !== null) {
      for (const [id, ovRaw] of Object.entries(colWidthsRaw as Record<string, unknown>)) {
        if (typeof ovRaw !== 'object' || ovRaw === null) continue;
        const { name, type, note } = ovRaw as Record<string, unknown>;
        const override: TableColumnWidthOverride = {};
        if (isFiniteNumber(name) && name > 0) override.name = name;
        if (isFiniteNumber(type) && type > 0) override.type = type;
        if (isFiniteNumber(note) && note > 0) override.note = note;
        // 有効な列が1つも無ければエントリ自体を作らない(空オブジェクトを残さない)。
        if (override.name !== undefined || override.type !== undefined || override.note !== undefined) {
          columnWidths[id] = override;
        }
      }
    }

    const version = isFiniteNumber(obj.version) ? obj.version : SIDECAR_VERSION;
    return { version, tablePositions, tableWidths, columnWidths };
  } catch {
    // JSON壊れ・読み取り失敗はフォールバック(自動レイアウト)。エラーは握りつぶす
    // (サイドカーは補助情報であり、無くても本アプリは機能するため)。
    return null;
  }
}

/**
 * サイドカーを書き込む。書き込みに失敗しても例外は投げず false を返す
 * (見た目状態の保存失敗でアプリの主機能=閲覧/編集を止めないため。呼び出し側でトースト等に使う)。
 */
export async function writeSidecar(dbmlPath: string, data: SidecarData): Promise<boolean> {
  const path = sidecarPathFor(dbmlPath);
  try {
    await writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
