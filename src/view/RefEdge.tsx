// Ref(リレーション)を表すエッジ。両端の実位置から「左右どちらの辺から線を出すか」を
// 毎描画で決める floating edge。カラム単位のハンドル(FK行の縦位置)を尊重しつつ、
// 相手テーブルに近い側の辺(left/right)を選ぶので、線が回り込まず自然につながる。
import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  Position,
  type EdgeProps,
  type InternalNode,
  type Node,
} from '@xyflow/react';
import { Box } from '@mui/material';
import type { RefMultiplicity } from '../parser/model';
import { columnHandleId } from './TableNode';

export interface RefEdgeData {
  multiplicity: RefMultiplicity;
  /** source 側 FK カラムID(あればそのカラム行の縦位置から線を出す)。無ければテーブル辺の中央。 */
  sourceColumnId?: string;
  /** target 側 FK カラムID。 */
  targetColumnId?: string;
  /**
   * 両端テーブルの少なくとも一方が表示対象外(薄表示)のとき true。
   * エッジ自体もあわせて薄く描画する(配置=パスは動かさない)。
   */
  dimmed?: boolean;
  [key: string]: unknown;
}

function multiplicityLabels(multiplicity: RefMultiplicity): [string, string] {
  switch (multiplicity) {
    case '1:1':
      return ['1', '1'];
    case '1:N':
      return ['1', 'N'];
    case 'N:1':
      return ['N', '1'];
    case 'N:N':
    default:
      return ['N', 'N'];
  }
}

interface EdgePoint {
  x: number;
  y: number;
  position: Position;
}

/**
 * ノードの左辺 / 右辺のうち、相手の中心Xに近い方を選び、その辺上の接続点を返す。
 * 縦位置(y)は指定カラムのハンドル位置を優先し、無ければノードの縦中央にする。
 * これで「左から来ているなら左につながる」を実現する(floating edge)。
 */
function edgePointToward(
  node: InternalNode<Node>,
  columnId: string | undefined,
  otherCenterX: number,
): EdgePoint {
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured?.width ?? node.width ?? 0;
  const height = node.measured?.height ?? node.height ?? 0;
  const nodeCenterX = x + width / 2;

  // 相手が右にいれば右辺、左にいれば左辺から出す。
  const useRight = otherCenterX >= nodeCenterX;
  const side: 'left' | 'right' = useRight ? 'right' : 'left';
  const edgeX = useRight ? x + width : x;
  const position = useRight ? Position.Right : Position.Left;

  // カラムのハンドル位置(縦オフセット)を探す。取れなければノード縦中央。
  let edgeY = y + height / 2;
  if (columnId) {
    const handleId = columnHandleId(columnId, side);
    // source/target どちらのバウンドにも同じIDのハンドルがあるため両方見る。
    const bounds = [
      ...(node.internals.handleBounds?.source ?? []),
      ...(node.internals.handleBounds?.target ?? []),
    ];
    const hb = bounds.find((h) => h.id === handleId);
    if (hb) edgeY = y + hb.y + hb.height / 2;
  }

  return { x: edgeX, y: edgeY, position };
}

function RefEdgeImpl({ source, target, data, markerEnd }: EdgeProps & { data?: RefEdgeData }) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  // ノード情報が未確定(初期描画等)のときは描かない。
  if (!sourceNode || !targetNode) return null;

  const sx = sourceNode.internals.positionAbsolute.x + (sourceNode.measured?.width ?? sourceNode.width ?? 0) / 2;
  const tx = targetNode.internals.positionAbsolute.x + (targetNode.measured?.width ?? targetNode.width ?? 0) / 2;

  const sp = edgePointToward(sourceNode, data?.sourceColumnId, tx);
  const tp = edgePointToward(targetNode, data?.targetColumnId, sx);

  const [edgePath] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    sourcePosition: sp.position,
    targetX: tp.x,
    targetY: tp.y,
    targetPosition: tp.position,
  });

  const [sourceLabel, targetLabel] = multiplicityLabels(data?.multiplicity ?? 'N:N');
  const dimmed = data?.dimmed ?? false;

  const labelSx = {
    position: 'absolute' as const,
    fontSize: 11,
    fontWeight: 700,
    bgcolor: 'background.paper',
    color: 'text.secondary',
    borderRadius: '50%',
    width: 16,
    height: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid',
    borderColor: 'divider',
    pointerEvents: 'none' as const,
    opacity: dimmed ? 0.2 : 1,
    transition: 'opacity 0.2s ease',
  };

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{ strokeWidth: 1.5, opacity: dimmed ? 0.2 : 1, transition: 'opacity 0.2s ease' }}
      />
      <EdgeLabelRenderer>
        <Box sx={{ ...labelSx, transform: `translate(-50%, -50%) translate(${sp.x + (tp.x - sp.x) * 0.12}px, ${sp.y + (tp.y - sp.y) * 0.12}px)` }}>
          {sourceLabel}
        </Box>
        <Box sx={{ ...labelSx, transform: `translate(-50%, -50%) translate(${sp.x + (tp.x - sp.x) * 0.88}px, ${sp.y + (tp.y - sp.y) * 0.88}px)` }}>
          {targetLabel}
        </Box>
      </EdgeLabelRenderer>
    </>
  );
}

export const RefEdge = memo(RefEdgeImpl);
