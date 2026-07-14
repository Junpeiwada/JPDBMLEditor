// LOD(詳細度切り替え)の状態管理。ズーム率が閾値未満かどうかを購読しつつ、
// ズーム/パン操作中は切り替えず、操作が完全に終わってから少し待って確定する
// (閾値をまたいだ瞬間に全ノードを一斉に「全カラム⇄代表行」へ再構築すると
//  1フレームに数千DOMの生成/破棄が集中し大カクつきになるため。ErCanvas.tsx 参照)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@xyflow/react';

// 操作終了後、少し待ってから最新の targetLod を確定LODへ反映する。
// 「少し待つ」のは onMoveEnd 直後の慣性/追従フレームと切替コストを重ねないため。
const LOD_APPLY_DELAY_MS = 120;

export interface LodState {
  /** 確定済みLOD状態(true=代表行のみに間引き表示)。ノードの data 生成に使う。 */
  isLod: boolean;
  /** ズーム/パン開始時に呼ぶ(操作中は絶対にLODを切り替えない)。 */
  onMoveStart: () => void;
  /** ズーム/パン終了時に呼ぶ(少し待ってから最新の targetLod を確定する)。 */
  onMoveEnd: () => void;
}

/**
 * LOD(詳細度切り替え)の閾値ベースの状態管理フック。
 * ズーム率(transform[2])が lodThreshold 未満かどうかを購読し(targetLod)、
 * 操作中でなければその変化を確定LOD(isLod)へ反映する。呼び出し側は
 * onMoveStart/onMoveEnd を ReactFlow の onMoveStart/onMoveEnd に配線する。
 */
export function useLodState(lodThreshold: number): LodState {
  // ズーム率を「LOD閾値未満か」の真偽値に畳んで購読する(生の目標値)。
  // zoom の生値ではなく bool を購読することで、連続ズーム中に閾値をまたがない限り
  // 再レンダリングされない。閾値(lodThreshold)が変わると、この bool が再評価されて即座に反映される。
  const targetLod = useStore((s) => s.transform[2] < lodThreshold);

  // 実際にノードへ渡す確定LOD状態。
  const [isLod, setIsLod] = useState(targetLod);

  // ズーム/パン操作中かどうか(onMoveStart〜onMoveEnd)。移動中は絶対にLODを切り替えない。
  // 「またいでから固定時間後」だと小刻みなズームの隙間で操作中に発火してしまうため、
  // 「操作の終了(onMoveEnd)」を明確な起点にする。
  const isMovingRef = useRef(false);
  // onMoveEnd 後にLOD確定を予約するタイマー。連続操作では張り直す。
  const lodApplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最新の targetLod を ref でも持つ(タイマーのクロージャから最新値を読むため)。
  const targetLodRef = useRef(targetLod);
  targetLodRef.current = targetLod;

  const scheduleLodApply = useCallback(() => {
    if (lodApplyTimerRef.current) clearTimeout(lodApplyTimerRef.current);
    lodApplyTimerRef.current = setTimeout(() => {
      lodApplyTimerRef.current = null;
      if (isMovingRef.current) return; // まだ動いているなら次の onMoveEnd に任せる
      setIsLod(targetLodRef.current);
    }, LOD_APPLY_DELAY_MS);
  }, []);

  // 操作していないとき(プログラム的な fitView 等で zoom が変わった場合)に備え、
  // 移動中でなければ targetLod の変化を即反映する(操作中は上の経路に任せる)。
  useEffect(() => {
    if (isMovingRef.current) return;
    if (targetLod !== isLod) scheduleLodApply();
  }, [targetLod, isLod, scheduleLodApply]);

  useEffect(() => {
    return () => {
      if (lodApplyTimerRef.current) clearTimeout(lodApplyTimerRef.current);
    };
  }, []);

  const onMoveStart = useCallback(() => {
    isMovingRef.current = true;
    // 移動が始まったら、保留中のLOD確定は取り消す(操作中は切り替えない)。
    if (lodApplyTimerRef.current) {
      clearTimeout(lodApplyTimerRef.current);
      lodApplyTimerRef.current = null;
    }
  }, []);

  const onMoveEnd = useCallback(() => {
    isMovingRef.current = false;
    // 操作が完全に終わってからLODを確定する(切替コストを操作の外へ逃がす)。
    scheduleLodApply();
  }, [scheduleLodApply]);

  return { isLod, onMoveStart, onMoveEnd };
}
