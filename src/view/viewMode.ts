// 表示モード(全体/絞り込み/フォーカス)を1箇所に集約する型定義。
// Docs/UI設計.md の「表示モードと状態遷移」に対応。

export type ViewMode =
  | { kind: 'all' }
  | { kind: 'filter'; query: string }
  | { kind: 'focus'; tableId: string; hops: number };

export const ALL_VIEW_MODE: ViewMode = { kind: 'all' };

/** フォーカス時のホップ数スライダーの初期値・範囲。 */
export const DEFAULT_FOCUS_HOPS = 1;
export const MIN_FOCUS_HOPS = 0;
export const MAX_FOCUS_HOPS = 4;

