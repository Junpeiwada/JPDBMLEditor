// テーブル幅リサイズ時の局所再配置(A: 右側の重なった相手だけ右へ押す)。
//
// 全体を再レイアウト(ELK再計算)すると手動配置がご破算になるため、幅を広げたテーブルの
// 右側で重なった相手だけを、重なりが消える最小量だけ右へずらす。押された相手がさらに右隣と
// 重なれば連鎖的に押す(横方向のみの単純な押し出し)。上下方向へは動かさない。
//
// 幅を「縮めた」場合は重なりが増えないため何もしない(呼び出し側で判定不要。この関数は
// 現在の矩形集合を見て重なりだけを解消するので、縮小時は差分が出ない)。

/** 矩形(React Flow ノード座標系。x,y は左上、w/h は実寸)。 */
export interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 押し出し後に座標が変わったテーブルの新座標(テーブルID→{x,y})。動かなかったものは含めない。 */
export type PositionDelta = Record<string, { x: number; y: number }>;

/** 縦方向に重なりがあるか(区間 [y, y+h) が交差するか)。 */
function overlapsVertically(a: Rect, b: Rect): boolean {
  return a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * `changedId` の幅変更(rects 内に反映済み)を起点に、右側で重なる相手を右へ押し出す。
 * 押した相手を起点にさらに右へ連鎖する(幅の広い相手が別の相手を押すこともある)。
 *
 * @param rects 全テーブルの現在の矩形(changedId の幅は変更後の値になっている前提)。
 * @param changedId 幅を変えたテーブルのID。
 * @param gap 押し出し後に相手との間に空ける最小マージン(px)。
 * @returns 座標が動いたテーブルの新座標マップ(動かなければ空)。
 */
export function resolveOverlapToRight(
  rects: Rect[],
  changedId: string,
  gap = 24,
): PositionDelta {
  const byId = new Map(rects.map((r) => [r.id, { ...r }]));
  const start = byId.get(changedId);
  if (!start) return {};

  const delta: PositionDelta = {};
  // 幅順ではなく「左端が右にあるものほど後で処理」だと連鎖の途中で取りこぼすため、
  // BFS 的に「押した相手を次の起点キューへ積む」方式にする。
  const queue: string[] = [changedId];
  // N 個が横一列に連鎖する最悪ケースでは、あるノードが複数回押され直すことがある
  // (各ノードが最大 N 回)。打ち切り上限は O(N^2) 相当を確保して途中終了を避ける。
  // それでも到達した場合は「相互に押し合う」等の異常なので、重なりを黙って残さず警告する。
  const maxIterations = rects.length * rects.length + rects.length + 8;
  let iterations = 0;

  while (queue.length > 0) {
    if (iterations++ >= maxIterations) {
      console.warn(
        'resolveOverlapToRight: 反復上限に達しました。重なりが残っている可能性があります',
        { changedId, tableCount: rects.length },
      );
      break;
    }
    const pusherId = queue.shift()!;
    const pusher = byId.get(pusherId)!;
    const pusherRight = pusher.x + pusher.w;

    for (const other of byId.values()) {
      if (other.id === pusherId) continue;
      // 縦に重ならない(別の段にある)相手は横がかぶっても視覚的に重ならないので無視。
      if (!overlapsVertically(pusher, other)) continue;
      // 「右側にいる」相手だけを押す(左端が pusher の左端以上=右方向にいる)。
      if (other.x < pusher.x) continue;
      // まだ重なっている(相手の左端が pusher の右端+gap より内側)なら右へずらす。
      const requiredLeft = pusherRight + gap;
      if (other.x < requiredLeft) {
        other.x = requiredLeft;
        delta[other.id] = { x: other.x, y: other.y };
        // 実際にずらしたときだけ、その相手を起点に右隣を押す連鎖を続ける
        // (座標が変わらないなら再処理しても新たな押し出しは起きないのでキューに積まない)。
        queue.push(other.id);
      }
    }
  }

  return delta;
}
