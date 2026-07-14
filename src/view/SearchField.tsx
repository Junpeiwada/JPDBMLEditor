// 検索フィールド(左サイドパネル最上部に常設)。
// Docs/UI設計.md「B. 左サイドパネル」に準拠。
//
// パフォーマンス設計: 検索入力の state はこのコンポーネント内部に閉じ、確定クエリ
// (debounce済み・IME確定後)のみを onQueryChange で親へ通知する。これにより
// 1キー入力ごとに App 全体(ErCanvas/SidePanel 含む)が再レンダリングされるのを防ぐ。
// IME変換中(composition中)の未確定文字列では通知せず、変換確定(compositionend)後に
// debounce して通知する。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { IconButton, InputAdornment, TextField } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';

const QUERY_DEBOUNCE_MS = 300;

/** App 側から検索フィールドを操作するための命令的ハンドル。 */
export interface SearchFieldHandle {
  /** 検索フィールドにフォーカスする(Cmd/Ctrl+F)。 */
  focusSearch: () => void;
  /** 検索フィールドからフォーカスを外す。 */
  blurSearch: () => void;
  /** 検索フィールドを空にし、即座に空クエリを親へ通知する(フォーカス遷移時など)。 */
  clearSearch: () => void;
  /** 検索フィールドがフォーカス中か(Esc の分岐判定用)。 */
  isSearchFocused: () => boolean;
}

interface SearchFieldProps {
  /** 確定クエリ(debounce済み・IME確定後)の通知。空文字は検索クリアを意味する。 */
  onQueryChange: (query: string) => void;
}

export const SearchField = forwardRef<SearchFieldHandle, SearchFieldProps>(function SearchField(
  { onQueryChange },
  ref,
) {
  const [searchInput, setSearchInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // IME変換中(compositionstart〜compositionend)かどうか。変換中は親へ通知しない。
  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  const cancelPendingNotify = useCallback(() => {
    if (debounceTimerRef.current != null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  // debounce してから確定クエリを親へ通知する。
  const notifyDebounced = useCallback(
    (value: string) => {
      cancelPendingNotify();
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        onQueryChange(value);
      }, QUERY_DEBOUNCE_MS);
    },
    [cancelPendingNotify, onQueryChange],
  );

  // クリアは debounce せず即時通知する([×]ボタン/Esc/フォーカス遷移時の応答性優先)。
  const clearSearch = useCallback(() => {
    cancelPendingNotify();
    setSearchInput('');
    onQueryChange('');
  }, [cancelPendingNotify, onQueryChange]);

  useImperativeHandle(
    ref,
    () => ({
      focusSearch: () => inputRef.current?.focus(),
      blurSearch: () => inputRef.current?.blur(),
      clearSearch,
      isSearchFocused: () => document.activeElement === inputRef.current,
    }),
    [clearSearch],
  );

  // アンマウント時に保留中の通知タイマーを破棄する。
  useEffect(() => cancelPendingNotify, [cancelPendingNotify]);

  return (
    <TextField
      inputRef={inputRef}
      value={searchInput}
      onChange={(e) => {
        const value = e.target.value;
        setSearchInput(value);
        // IME変換中の未確定文字列では通知しない(確定は onCompositionEnd で行う)。
        if (!isComposingRef.current) {
          notifyDebounced(value);
        }
      }}
      placeholder="検索: テーブル名・カラム名"
      size="small"
      variant="outlined"
      fullWidth
      slotProps={{
        htmlInput: {
          onCompositionStart: () => {
            isComposingRef.current = true;
          },
          onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement>) => {
            isComposingRef.current = false;
            notifyDebounced(e.currentTarget.value);
          },
        },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: searchInput && (
            <InputAdornment position="end">
              <IconButton size="small" onClick={clearSearch} aria-label="検索をクリア">
                <ClearIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
});
