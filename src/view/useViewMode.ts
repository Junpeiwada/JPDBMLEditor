// 表示モード(全体/絞り込み/フォーカス)の遷移をまとめるフック。
// Docs/UI設計.md の「表示モードと状態遷移」の表に厳密に従う:
//   全体      --検索入力--> 絞り込み
//   全体      --テーブルクリック--> フォーカス
//   絞り込み  --検索クリア--> 全体              (フォーカスへは戻らない)
//   絞り込み  --テーブルクリック--> フォーカス   (絞り込み結果からのフォーカスも可)
//   フォーカス --全体に戻る/背景クリック/Esc--> 全体
//   フォーカス --検索入力--> 絞り込み            (フォーカス状態は破棄)
//
// モードは排他なので、フォーカス状態と検索クエリを同時に持たず、
// 検索クエリが非空になった瞬間にフォーカス状態を破棄する(逆に検索クリアでは
// 全体に戻るだけで、破棄済みのフォーカスは復元しない = 表の「検索クリア→全体」に一致)。
import { useCallback, useMemo, useState } from 'react';
import { isEmptyQuery } from './filter';
import { DEFAULT_FOCUS_HOPS, type ViewMode } from './viewMode';

export interface UseViewModeResult {
  viewMode: ViewMode;
  /** debounce 済みの検索クエリ(絞り込み判定・フィルタ計算に使う)。 */
  debouncedQuery: string;
  /** フォーカス中テーブルをクリックしたとき/一覧から選んだときに呼ぶ。検索クエリは破棄してフォーカスへ遷移する。 */
  focusTable: (tableId: string) => void;
  /**
   * ホップ数変更時(番号ボタン)に呼ぶ(フォーカス中のみ意味を持つ)。
   * 変更した値は別テーブルへのフォーカス乗り換え後も維持される。
   */
  setFocusHops: (hops: number) => void;
  /** 「全体」ボタン/背景クリック/Esc で呼ぶ。フォーカス解除して全体へ(ホップ数も初期値に戻す)。 */
  clearFocus: () => void;
  /** 検索クエリ確定時(debounce後)に呼ぶ。非空ならフォーカスを破棄して絞り込みへ。 */
  setDebouncedQuery: (query: string) => void;
}

export function useViewMode(): UseViewModeResult {
  const [debouncedQuery, setDebouncedQueryState] = useState('');
  const [focusTableId, setFocusTableId] = useState<string | null>(null);
  // ホップ数はフォーカス対象と独立に保持する。これにより、別のテーブルに
  // フォーカスし直してもユーザーが変更したホップ数を維持できる。
  // フォーカス解除(clearFocus)時に初期値(1)へ戻す。
  const [focusHops, setFocusHopsState] = useState(DEFAULT_FOCUS_HOPS);

  const focusTable = useCallback((tableId: string) => {
    // 絞り込み結果からのフォーカスも可(表参照)。フォーカスへ移るので検索は解除する。
    // ホップ数は意図的にリセットしない(フォーカス乗り換え時は前回値を維持)。
    setDebouncedQueryState('');
    setFocusTableId(tableId);
  }, []);

  const setFocusHops = useCallback((hops: number) => {
    setFocusHopsState(hops);
  }, []);

  const clearFocus = useCallback(() => {
    setFocusTableId(null);
    setFocusHopsState(DEFAULT_FOCUS_HOPS);
  }, []);

  const setDebouncedQuery = useCallback((query: string) => {
    setDebouncedQueryState(query);
    // 検索入力でフォーカスから絞り込みへ移る場合、フォーカス状態は破棄する
    // (表の「フォーカス --検索入力--> 絞り込み」、および絞り込み解除時に
    //  フォーカスへ戻らないようにするため)。フォーカス終了なのでホップ数も初期化する。
    if (!isEmptyQuery(query)) {
      setFocusTableId(null);
      setFocusHopsState(DEFAULT_FOCUS_HOPS);
    }
  }, []);

  const viewMode: ViewMode = useMemo(() => {
    if (!isEmptyQuery(debouncedQuery)) {
      return { kind: 'filter', query: debouncedQuery.trim() };
    }
    if (focusTableId != null) {
      return { kind: 'focus', tableId: focusTableId, hops: focusHops };
    }
    return { kind: 'all' };
  }, [debouncedQuery, focusTableId, focusHops]);

  return {
    viewMode,
    debouncedQuery,
    focusTable,
    setFocusHops,
    clearFocus,
    setDebouncedQuery,
  };
}
