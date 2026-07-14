// パフォーマンス計測の基盤。
// - perfSpan / perfSpanAsync: 処理区間の所要時間を performance.measure で記録する。
//   記録した区間は DevTools(Safari Web Inspector / Chrome)の Performance タイムラインにも
//   「Timings」として表示されるため、深掘りプロファイル時の目印になる。
// - 併せて名前ごとの最新値をストアに保持し、PerfOverlay(Cmd/Ctrl+Shift+P)が購読して表示する。
// - 計測自体のオーバーヘッドは µs オーダーなので、開発/本番どちらのビルドでも常時有効にする。

export interface PerfEntry {
  /** 計測名。オーバーレイの1行になる(名前順で並ぶため「1|〜」の接頭辞で段階順を表す)。 */
  name: string;
  /** 所要時間(ms)。 */
  ms: number;
  /** 補足情報(テーブル数・ヒット件数など)。 */
  detail?: string;
  /** 記録時刻(performance.now() 基準)。 */
  at: number;
}

type Listener = () => void;

const latestByName = new Map<string, PerfEntry>();
const listeners = new Set<Listener>();
let snapshotCache: PerfEntry[] = [];
let snapshotDirty = true;

// リスナー通知はマイクロタスクへ遅延させ、連続する計測を1回の通知にまとめる。
// perfSpan は useMemo など「レンダリング中」に呼ばれるため、そこで同期通知すると
// PerfOverlay(useSyncExternalStore)の再レンダリングをレンダリング中にスケジュールしてしまい
// React が「Cannot update a component while rendering a different component」を出す。
// 値の記録(latestByName/snapshotDirty)は同期で済ませ、通知だけを次のマイクロタスクへ逃がす。
let flushScheduled = false;
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    for (const listener of listeners) listener();
  });
}

/** 計測値を1件記録する(同名は最新値で上書き)。 */
export function recordPerf(name: string, ms: number, detail?: string): void {
  latestByName.set(name, { name, ms, detail, at: performance.now() });
  snapshotDirty = true;
  scheduleFlush();
}

/** 同期処理の区間計測。detail で件数などの補足を結果から生成できる。 */
export function perfSpan<T>(name: string, fn: () => T, detail?: (result: T) => string): T {
  const start = performance.now();
  const result = fn();
  finishSpan(name, start, detail?.(result));
  return result;
}

/** 非同期処理の区間計測(await 完了までを1区間とする)。 */
export async function perfSpanAsync<T>(
  name: string,
  fn: () => Promise<T>,
  detail?: (result: T) => string,
): Promise<T> {
  const start = performance.now();
  const result = await fn();
  finishSpan(name, start, detail?.(result));
  return result;
}

function finishSpan(name: string, start: number, detail?: string): void {
  const end = performance.now();
  try {
    // DevTools のタイムラインに区間として出すための measure(未対応環境でも計測自体は続行)。
    performance.measure(name, { start, end });
  } catch {
    // no-op
  }
  recordPerf(name, end - start, detail);
}

/** ストアの変更を購読する(useSyncExternalStore 用)。 */
export function subscribePerf(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 最新の計測値一覧(名前順)。参照が安定するようキャッシュする(useSyncExternalStore 用)。 */
export function getPerfSnapshot(): PerfEntry[] {
  if (snapshotDirty) {
    snapshotCache = [...latestByName.values()].sort((a, b) => a.name.localeCompare(b.name));
    snapshotDirty = false;
  }
  return snapshotCache;
}

// ---------------------------------------------------------------------------
// 時系列トレース記録。
// 「どの操作の最中に、何フレーム・どれだけ描画が詰まったか」を時系列で残すための機能。
// - 記録中は毎フレーム(rAF)のフレーム時間(前フレームからの経過ms)を溜める。
//   16.7ms が 60fps、跳ね上がった値=そのフレームで描画/レイアウトが詰まった量。
// - markEvent で操作(ドラッグ開始/移動/終了・ズームなど)に時刻付きの目印を打つ。
// - stopTrace で両者を時間順にマージし、コンソールに表として出す(コピペ可能)。
// 記録していない間のコストはゼロ(rAF も回さない)。
// ---------------------------------------------------------------------------

interface FrameSample {
  /** 記録開始からの経過ms。 */
  t: number;
  /** 前フレームからの経過ms(フレーム時間)。 */
  dt: number;
}

interface EventSample {
  /** 記録開始からの経過ms。 */
  t: number;
  /** 操作名(例: 'drag:start', 'drag:move', 'zoom')。 */
  label: string;
  /** 補足(ノードIDなど)。 */
  detail?: string;
}

let tracing = false;
let traceStart = 0;
let lastFrameAt = 0;
let traceRafId = 0;
const frameSamples: FrameSample[] = [];
const eventSamples: EventSample[] = [];
const traceListeners = new Set<Listener>();

/** トレース記録中かどうか(オーバーレイの表示切り替え用)。 */
export function isTracing(): boolean {
  return tracing;
}

export function subscribeTrace(listener: Listener): () => void {
  traceListeners.add(listener);
  return () => {
    traceListeners.delete(listener);
  };
}

function notifyTrace() {
  for (const listener of traceListeners) listener();
}

/** 記録を開始する。既存の記録はクリアする。 */
export function startTrace(): void {
  if (tracing) return;
  tracing = true;
  traceStart = performance.now();
  lastFrameAt = traceStart;
  frameSamples.length = 0;
  eventSamples.length = 0;
  const loop = () => {
    const now = performance.now();
    frameSamples.push({ t: now - traceStart, dt: now - lastFrameAt });
    lastFrameAt = now;
    traceRafId = requestAnimationFrame(loop);
  };
  traceRafId = requestAnimationFrame(loop);
  notifyTrace();
}

/**
 * 操作イベントを時系列に記録する(記録中のみ有効)。
 * ドラッグ移動のように高頻度で呼ばれるものは、直前が同じ label なら間引く
 * (最初と最後だけ残せば「いつからいつまでその操作中か」は分かる)。
 */
export function markEvent(label: string, detail?: string): void {
  if (!tracing) return;
  const t = performance.now() - traceStart;
  const last = eventSamples[eventSamples.length - 1];
  if (last && last.label === label && t - last.t < 100) {
    // 同種イベントの連続は 100ms 未満なら上書き(区間の終端を更新するイメージ)。
    last.t = t;
    last.detail = detail;
    return;
  }
  eventSamples.push({ t, label, detail });
}

/** トレースの解析結果(コンソール表示・ファイル書き出し両方の元データ)。 */
export interface TraceResult {
  summary: {
    frames: number;
    /** 記録時間(ms)。 */
    durationMs: number;
    /** 平均フレーム時間(ms)と、そこから逆算した平均FPS。 */
    avgDt: number;
    avgFps: number;
    /** 最悪フレーム時間(ms)。 */
    worstDt: number;
    /** カクつき(>33ms)フレーム数と、その割合(%)。 */
    jankFrames: number;
    jankPct: number;
  };
  /** フレームとイベントを時間順にマージした1本の時系列(私=Claudeが直接読める形)。 */
  timeline: Array<{ t: number; kind: string; value: string }>;
}

const JANK_THRESHOLD_MS = 33; // 30fps を下回るフレーム = カクつき

/** 記録を停止し、時系列トレースをコンソールに出力する。解析結果を返す(ファイル書き出し用)。 */
export function stopTrace(): TraceResult | null {
  if (!tracing) return null;
  tracing = false;
  cancelAnimationFrame(traceRafId);

  const worstDt = frameSamples.reduce((m, f) => Math.max(m, f.dt), 0);
  const jankFrames = frameSamples.filter((f) => f.dt > JANK_THRESHOLD_MS).length;
  const durationMs = frameSamples.length ? frameSamples[frameSamples.length - 1].t : 0;
  const totalDt = frameSamples.reduce((s, f) => s + f.dt, 0);
  const avgDt = frameSamples.length ? totalDt / frameSamples.length : 0;

  const timeline: TraceResult['timeline'] = [];
  for (const f of frameSamples) {
    timeline.push({
      t: Math.round(f.t),
      kind: f.dt > JANK_THRESHOLD_MS ? 'FRAME⚠' : 'frame',
      value: f.dt.toFixed(1),
    });
  }
  for (const e of eventSamples) {
    timeline.push({ t: Math.round(e.t), kind: `◆${e.label}`, value: e.detail ?? '' });
  }
  timeline.sort((a, b) => a.t - b.t);

  const result: TraceResult = {
    summary: {
      frames: frameSamples.length,
      durationMs: Math.round(durationMs),
      avgDt: Number(avgDt.toFixed(1)),
      avgFps: avgDt > 0 ? Math.round(1000 / avgDt) : 0,
      worstDt: Number(worstDt.toFixed(1)),
      jankFrames,
      jankPct: frameSamples.length ? Math.round((jankFrames / frameSamples.length) * 100) : 0,
    },
    timeline,
  };

  console.group(
    `%c[perf trace] ${result.summary.frames}フレーム / 平均${result.summary.avgFps}fps / カクつき ${jankFrames}枚(${result.summary.jankPct}%) / 最悪 ${worstDt.toFixed(1)}ms`,
    'color:#9fef9f;font-weight:bold',
  );
  console.table(timeline);
  console.groupEnd();

  notifyTrace();
  return result;
}
