// ELK.js による自動レイアウトの共通インターフェース。
// 「nodes/edges を受け取り、座標付き nodes を返す」という最小限の契約にする。

export type LayoutEngine = 'elk';

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  id: string;
  source: string;
  target: string;
}

export interface LayoutNodeOutput {
  id: string;
  x: number;
  y: number;
}

export interface LayoutInput {
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
}

export interface LayoutResult {
  nodes: LayoutNodeOutput[];
}

export type LayoutFn = (input: LayoutInput) => Promise<LayoutResult>;
