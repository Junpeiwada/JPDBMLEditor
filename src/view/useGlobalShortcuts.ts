// グローバルキーボードショートカット(F12/IME変換中判定/Cmd+S/Cmd+Z/Cmd+F/Cmd+0/Esc)一式をまとめるフック。
import { useEffect } from "react";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ViewMode } from "./viewMode";
import type { CameraCommand } from "./ErCanvas";
import type { SearchFieldHandle } from "./SearchField";

// グローバルUndo/Redoは、テキスト入力要素(input/textarea/contentEditable)に
// フォーカスがある間は発火させない(ブラウザ/IME標準のUndoと衝突させないため)。
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("input,textarea")) return true;
  if (target.isContentEditable) return true;
  return false;
}

interface UseGlobalShortcutsParams {
  viewMode: ViewMode;
  discardGuardOpen: boolean;
  fireCameraCommand: (type: CameraCommand["type"]) => void;
  handleSave: () => void;
  undo: () => void;
  redo: () => void;
  handleClearFocus: () => void;
  searchFieldRef: RefObject<SearchFieldHandle | null>;
}

// Cmd/Ctrl+F で検索フィールドにフォーカス。Cmd/Ctrl+0 で全体フィット(B1)。
// Cmd/Ctrl+S で明示保存。Cmd/Ctrl+Z / Shift+Z でUndo/Redo(入力要素フォーカス中は無効化)。
// Esc は「検索フィールドフォーカス中なら検索クリア」を優先し、それ以外はフォーカスモード解除。
// IME変換中の Esc/Enter 等(変換キャンセル/確定)には反応しない。
// 未保存破棄ガードのダイアログ表示中は、裏でフォーカス解除等が起きて表示状態と
// 食い違わないよう、Escによる副作用を止める。
export function useGlobalShortcuts({
  viewMode,
  discardGuardOpen,
  fireCameraCommand,
  handleSave,
  undo,
  redo,
  handleClearFocus,
  searchFieldRef,
}: UseGlobalShortcutsParams): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // F12: 開発者ツール(Inspect Element)のトグル。ダイアログ表示中でも使えるよう
      // discardGuardOpen の早期returnより前で処理する(release ビルドでは Rust 側でno-op)。
      if (e.key === "F12") {
        e.preventDefault();
        void invoke("toggle_devtools");
        return;
      }
      // IME変換中(isComposing だけでは環境により取りこぼすため keyCode 229 も併用)は
      // 以降のショートカット判定を一切行わない。
      const isComposing = e.isComposing || e.keyCode === 229;
      if (isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      if (!isTypingTarget(e.target) && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }
      if (discardGuardOpen) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchFieldRef.current?.focusSearch();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        fireCameraCommand("fit-all");
        return;
      }
      if (e.key === "Escape") {
        if (searchFieldRef.current?.isSearchFocused()) {
          searchFieldRef.current.clearSearch();
          searchFieldRef.current.blurSearch();
        } else if (viewMode.kind === "focus") {
          handleClearFocus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [viewMode.kind, handleClearFocus, discardGuardOpen, fireCameraCommand, handleSave, undo, redo]);
}
