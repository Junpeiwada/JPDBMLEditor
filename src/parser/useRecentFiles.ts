// 最近開いたファイル(フルパス)の履歴を localStorage で永続管理するフック。
// - openFile / openPath で開くたびに先頭へ追加(既存の同一パスは重複させず先頭へ繰り上げ)
// - 最大 MAX_RECENT 件まで(古いものから溢れる)
// - 開こうとしたファイルが欠損していた場合は remove で履歴から取り除く
// LOD閾値・カラーモードと同じく localStorage を採用(Rust側の変更不要・実装が軽い)。
import { useCallback, useEffect, useState } from 'react';

/** 履歴の最大保持件数。ドロップダウンで一覧するため多すぎない範囲に収める。 */
export const MAX_RECENT = 20;

const STORAGE_KEY = 'jpdbml.recentFiles';

/** localStorage から復元する(壊れていれば空配列へフォールバック)。 */
function loadInitial(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 文字列以外/空文字は除外し、念のため上限で切る。
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export interface UseRecentFilesResult {
  /** 新しい順(先頭が最新)のフルパス一覧。 */
  recentFiles: string[];
  /** パスを履歴の先頭に追加する(既存の同一パスは先頭へ繰り上げ)。 */
  add: (path: string) => void;
  /** 指定パスを履歴から取り除く(欠損検知時など)。 */
  remove: (path: string) => void;
}

/**
 * 最近開いたファイルの履歴を localStorage 永続で保持するフック。
 * add/remove は状態更新と同時に localStorage へ書き込む。
 */
export function useRecentFiles(): UseRecentFilesResult {
  const [recentFiles, setRecentFiles] = useState<string[]>(loadInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recentFiles));
    } catch {
      // プライベートモード等で書けなくてもアプリは動作継続(セッション内は有効)。
    }
  }, [recentFiles]);

  const add = useCallback((path: string) => {
    setRecentFiles((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, MAX_RECENT));
  }, []);

  const remove = useCallback((path: string) => {
    setRecentFiles((prev) => prev.filter((p) => p !== path));
  }, []);

  return { recentFiles, add, remove };
}
