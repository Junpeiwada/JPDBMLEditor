// パフォーマンス計測オーバーレイ。Cmd/Ctrl+Shift+P で表示を切り替える。
// - perf.ts のストアを購読し、各処理段階の最新所要時間を一覧表示する。
// - 表示中のみ FPS(requestAnimationFrame ベース)と DOM 要素数を定期更新する
//   (非表示時の計測コストはゼロ。オーバーレイ自体が負荷にならないようにする)。
// - pointerEvents を切ってあるので、表示したままER図の操作(パン/ズーム/クリック)ができる。
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Typography } from '@mui/material';
import { writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { subscribePerf, getPerfSnapshot, subscribeTrace, isTracing, startTrace, stopTrace } from './perf';

// 記録停止時にトレース結果(JSON)を書き出すディレクトリ(リポジトリ直下 PerfLog/、.gitignore 済み)。
// 開発時のみ使う機能なので絶対パス固定でよい。Claude が直接読んで分析できる(コピペ不要)。
const TRACE_OUTPUT_DIR = '/Users/junpeiwada/Documents/Project/JPDBMLEditor/PerfLog';

/** 書き出しファイル名用の `YYYYMMDD-HHMMSS`(ローカル時刻)。記録ごとに別ファイルとして残す。 */
function traceFileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const FPS_UPDATE_INTERVAL_MS = 500;
const DOM_COUNT_INTERVAL_MS = 1000;

export function PerfOverlay() {
  const [visible, setVisible] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const [domCount, setDomCount] = useState<number | null>(null);
  const entries = useSyncExternalStore(subscribePerf, getPerfSnapshot);
  const tracing = useSyncExternalStore(subscribeTrace, isTracing);
  // 直近の書き出し結果メッセージ(オーバーレイに表示)。
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Cmd/Ctrl+Shift+P: オーバーレイ表示トグル。
  // Cmd/Ctrl+Shift+R: 時系列トレースの記録トグル(停止時にコンソールへ表を出力)。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setVisible((prev) => !prev);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        setVisible(true); // 記録中は必ず見えるように
        if (isTracing()) {
          const result = stopTrace();
          if (result) {
            // トレースをJSONで書き出す(Claudeが直接読める)。コンソールにも表は出ている。
            const fileName = `perf-trace-${traceFileStamp()}.json`;
            mkdir(TRACE_OUTPUT_DIR, { recursive: true })
              .then(() => writeTextFile(`${TRACE_OUTPUT_DIR}/${fileName}`, JSON.stringify(result, null, 2)))
              .then(() =>
                setSavedMsg(
                  `保存: PerfLog/${fileName} / 平均${result.summary.avgFps}fps / カクつき${result.summary.jankPct}% / 最悪${result.summary.worstDt}ms`,
                ),
              )
              .catch((err) => setSavedMsg(`書き出し失敗: ${String(err)}`));
          }
        } else {
          setSavedMsg(null);
          startTrace();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // FPS 計測: 表示中のみ rAF ループを回し、一定間隔ごとにフレーム数から算出する。
  // パン/ズーム中のカクつきはここの数値低下として現れる。
  useEffect(() => {
    if (!visible) return;
    let frameCount = 0;
    let windowStart = performance.now();
    let rafId = 0;
    const loop = () => {
      frameCount += 1;
      const now = performance.now();
      const elapsed = now - windowStart;
      if (elapsed >= FPS_UPDATE_INTERVAL_MS) {
        setFps(Math.round((frameCount * 1000) / elapsed));
        frameCount = 0;
        windowStart = now;
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [visible]);

  // DOM 要素数: 描画負荷の目安。表示中のみ1秒間隔で数える。
  useEffect(() => {
    if (!visible) return;
    const update = () => setDomCount(document.getElementsByTagName('*').length);
    update();
    const id = setInterval(update, DOM_COUNT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [visible]);

  if (!visible) return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        left: 12,
        bottom: 40,
        zIndex: (t) => t.zIndex.tooltip + 1,
        bgcolor: 'rgba(0, 0, 0, 0.75)',
        color: '#9fef9f',
        borderRadius: 1,
        px: 1.5,
        py: 1,
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.6,
        pointerEvents: 'none',
        minWidth: 280,
      }}
    >
      <Typography sx={{ fontSize: 'inherit', fontFamily: 'inherit', fontWeight: 'bold', color: '#fff' }}>
        計測 (Cmd/Ctrl+Shift+P で閉じる)
      </Typography>
      <Typography
        sx={{
          fontSize: 'inherit',
          fontFamily: 'inherit',
          color: tracing ? '#ff6b6b' : '#888',
          fontWeight: tracing ? 'bold' : 'normal',
        }}
      >
        {tracing
          ? '● 記録中… 操作して Cmd/Ctrl+Shift+R で停止'
          : (savedMsg ?? 'Cmd/Ctrl+Shift+R で時系列記録を開始')}
      </Typography>
      <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          <Row label="FPS" value={fps != null ? String(fps) : '-'} />
          <Row label="DOM要素数" value={domCount != null ? domCount.toLocaleString() : '-'} />
          {entries.map((e) => (
            <Row key={e.name} label={e.name} value={`${e.ms.toFixed(1)}ms`} detail={e.detail} />
          ))}
        </tbody>
      </Box>
    </Box>
  );
}

function Row({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <tr>
      <td style={{ paddingRight: 12, whiteSpace: 'nowrap' }}>{label}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{value}</td>
      <td style={{ paddingLeft: 8, opacity: 0.7, whiteSpace: 'nowrap' }}>{detail ?? ''}</td>
    </tr>
  );
}
