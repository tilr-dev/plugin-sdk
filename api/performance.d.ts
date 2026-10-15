import type { Context } from 'cordis';
export declare const PERFORMANCE_KEY = "tilr.performance.enabled";
/** How far back the live history (samples, events, metric buckets) reaches, ms. */
export declare const HISTORY = 120000;
/** The 1 s sampler's period, ms. */
export declare const SAMPLE_INTERVAL = 1000;
/**
 * The rAF loop runs only while something reads frame data: the Performance window is open
 * (`demand('window')`), a recording runs (`demand('recording')`), or `metrics()` (the exporter)
 * was read within the last FRAME_DEMAND_MS. Otherwise no rAF callback is scheduled and a
 * sample's FPS / frame percentiles are null ("n/a"); the 1 s sampler keeps running.
 */
export declare const FRAME_DEMAND_MS = 5000;
/** A native process reply arriving later than this after the previous one marks its sample
 *  `late`: the page's main thread was blocked (the request is driven by the page's timer). */
export declare const STALL_MS = 1500;
/** At most this many metric series (name + labels); observations of further ones are counted in
 *  `dropped.series`. */
export declare const MAX_SERIES = 512;
/** Each series keeps its last METRIC_RING observations (for p50 / p95 / max of a recent window). */
export declare const METRIC_RING = 256;
/** Event Timing of one input: `delay` = processingStart - startTime, `processing` =
 *  processingEnd - processingStart (ms); the event's `duration` is until the next paint. */
export interface InputTiming {
    type: string;
    delay: number;
    processing: number;
}
export interface PerfEvent {
    t: number;
    kind: string;
    plugin: string;
    name: string;
    duration: number | null;
    window?: string;
    count?: number;
    detail?: ReactDetail;
    input?: InputTiming;
}
export interface ProcessMetric {
    pid: number;
    name: string;
    scope: string;
    cpu: number | null;
    cpuSeconds: number;
    memory: number;
}
/** `late`: the native process reply came more than STALL_MS after the previous one (a
 *  main-thread stall); `gap`: the ms between the two replies. */
export interface PerfSample {
    t: number;
    visible: boolean;
    fps: number | null;
    frameP95: number | null;
    frameMax: number | null;
    commits: number;
    renderMs: number;
    processes: ProcessMetric[];
    listeners?: Record<string, number>;
    late?: boolean;
    gap?: number;
}
/**
 * One metric series in a snapshot / recording: what `metric(name, value, labels)` observed.
 * Times are `performance.now()` ms of the page (the recording's `origin` is its timeOrigin).
 */
export interface PerfMetric {
    /** Dotted lowercase: `server.decode`. */
    name: string;
    /** Sorted by key; string values only. */
    labels: Record<string, string>;
    /** Since the series' first observation in this collection session (not clipped to the
     *  snapshot's window). */
    count: number;
    sum: number;
    min: number;
    max: number;
    last: number;
    /** When `last` was observed. */
    t: number;
    /** The latest observations (at most METRIC_RING, 256) inside the snapshot's window, oldest
     *  first, as [t, value]. */
    recent: [number, number][];
    /** Per-second buckets inside the snapshot's window (at most 120), oldest first, as
     *  [second, count, sum] with second = Math.floor(t / 1000); seconds without observations
     *  are left out. */
    seconds: [number, number, number][];
}
/**
 * The recording format, version 1. `dropped`: what bounded buffers dropped inside the
 * recording's window, by event kind (`react`, `component`, `handler`, …), plus `series` (metric
 * observations refused at MAX_SERIES) and `invalid` (malformed metric() calls). `metrics` is
 * absent in recordings made before metrics existed.
 */
export interface PerfRecording {
    version: 1;
    origin: number;
    react: string;
    started: number;
    ended: number;
    samples: PerfSample[];
    events: PerfEvent[];
    dropped: Record<string, number>;
    metrics?: PerfMetric[];
}
interface Total {
    commits: number;
    renders: number;
    renderMs: number;
    loads: number;
    reloads: number;
    starts: number;
    errors: number;
    operationMs: number;
    handlers: number;
    handlerMs: number;
    loadMs: number;
    loadBuckets: number[];
}
export interface Fiber {
    tag: number;
    flags: number;
    actualDuration?: number;
    child?: Fiber;
    sibling?: Fiber;
    return?: Fiber;
    alternate?: Fiber | null;
    subtreeFlags?: number;
    type?: {
        name?: string;
        displayName?: string;
    };
    memoizedProps?: Record<string, unknown>;
    memoizedState?: unknown;
    dependencies?: {
        firstContext?: ContextDependency | null;
    } | null;
    stateNode?: unknown;
}
interface ContextDependency {
    context: unknown;
    memoizedValue?: unknown;
    next?: ContextDependency | null;
}
export interface ReactDetail {
    id: number;
    parent: number | null;
    depth: number;
    reason: string;
    props: string[];
    selfMs: number | null;
    candidate: boolean;
}
/** Inferences from committed Fiber data, never proof that a render was unnecessary. No values are retained. */
export declare function renderReason(fiber: Fiber): Pick<ReactDetail, 'reason' | 'props' | 'candidate'>;
export declare let performanceCollector: PerformanceCollector | undefined;
export declare function performanceRequested(): boolean;
export declare function requestPerformance(on: boolean): void;
export declare function bootPerformance(): void;
export declare function stopPerformance(): void;
export declare function percentile(values: number[], q: number): number | null;
/** The first index of `list` (sorted by `t`) whose `t` is >= `t`. */
export declare function lowerBound(list: readonly {
    t: number;
}[], t: number): number;
/** p50 / p95 / max of `values` came from all observations of the window (`full`), or only from
 *  the series' ring of the latest METRIC_RING, which does not reach back to the window's start
 *  (`tail`: older observations of the window were overwritten). */
export type Coverage = 'full' | 'tail';
/** Whether `m.recent` covers (from, …]: not when the ring has overwritten observations (count >
 *  METRIC_RING), is full and its oldest entry is newer than `from`. */
export declare function coverage(m: Pick<PerfMetric, 'count' | 'recent'>, from: number): Coverage;
/**
 * What the window and `tilr ctl debug metrics` show of a series over (end - window, end]:
 * observations/s from the per-second buckets of the whole seconds inside the window (the
 * partial oldest and the partial current second are left out), p50 / p95 / max of the recent
 * values, `n` of them and their `coverage`.
 */
export declare function metricStats(m: PerfMetric, end: number, window?: number): {
    rate: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
    values: number[];
    n: number;
    coverage: Coverage;
};
/** Prometheus text for metric series: `tilr_metric_{count,sum}` (counters since the series'
 *  first observation; values are non-negative, so `_sum` only grows) and
 *  `tilr_metric_{p50,p95,max}` (gauges over the values of the last `window` ms, left out when
 *  there are none) with `tilr_metric_n` (how many values) and `tilr_metric_tail` (1: the ring of
 *  the latest 256 did not reach back over the whole window), with the metric's `name` and its
 *  labels. */
export declare function metricExposition(metrics: readonly PerfMetric[], now: number, window?: number): string[];
/** One series of `metric()`: totals, a ring of the last METRIC_RING observations and
 *  per-second buckets over METRIC_SECONDS. Fixed size from the first observation on. */
declare class Series {
    count: number;
    sum: number;
    min: number;
    max: number;
    last: number;
    t: number;
    private readonly times;
    private readonly values;
    private next;
    private size;
    private readonly secondIds;
    private readonly secondCounts;
    private readonly secondSums;
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
    constructor(name: string, labels: Readonly<Record<string, string>>);
    /** `t` is when the observation happened, which may be earlier than the previous one's (an
     *  Event Timing entry's startTime): the ring is sorted when read, and a second older than the
     *  buckets reach back is left out of them (never overwrites a newer one). */
    add(t: number, value: number): void;
    view(since: number, now: number): PerfMetric;
}
export declare class PerformanceCollector {
    readonly origin: number;
    readonly started: number;
    readonly samples: PerfSample[];
    /** Everything but Cordis handler calls, bounded to MAX_EVENTS (20,000), sorted by `t`. */
    readonly events: PerfEvent[];
    /** Cordis handler calls (`handler`), bounded to MAX_HANDLER_EVENTS (5,000), sorted by `t`. */
    readonly handlers: PerfEvent[];
    readonly marks: Map<string, number>;
    readonly totals: Map<string, Total>;
    readonly listeners: Set<() => void>;
    /** Metric series by name + sorted labels. */
    readonly series: Map<string, Series>;
    /** Everything the bounded buffers dropped in this session, by kind (see PerfRecording). */
    readonly dropped: Record<string, number>;
    analysisPlugin: string | null;
    highlight: boolean;
    private dropLog;
    private fiberIDs;
    private nextFiberID;
    private flashes;
    private flashPending;
    private flashFrame;
    private flashTimer;
    analyze(plugin: string | null, highlight?: boolean): void;
    private clearHighlights;
    private fiberID;
    /** Notes the rendered host element during the commit; its rectangle is read after the commit,
     *  in the next frame, never inside React's commit hook (that would force a layout there). */
    private flash;
    private drawFlashes;
    private frame;
    private framing;
    private frameFrom;
    private frameUntil;
    private demands;
    private timer;
    private lastFrame;
    private lastSample;
    private deltas;
    private intervalCommits;
    private intervalRender;
    private pending;
    private disposed;
    private processes;
    private processAt;
    private replyAt;
    private observers;
    private lagChannel;
    private lagSent;
    private restoreHook;
    private restoreEvents;
    private subscriptions;
    private frameBuckets;
    private frameSum;
    private frameCount;
    /** React roots whose last commit left a tree (an unmount commits an empty one). */
    private roots;
    private visibility;
    constructor();
    /**
     * Something that reads frame data starts (`on`) or stops needing it: `'window'` (the
     * Performance window is open), `'recording'`. Counted per reason. See FRAME_DEMAND_MS.
     */
    demand(reason: string, on: boolean): void;
    /** Whether the rAF loop runs now. */
    get framesOn(): boolean;
    private wantsFrames;
    private frames;
    private stopFrames;
    private tick;
    private total;
    /** Counts `n` dropped items of `kind`, for the session and for recordings (by time). */
    private drop;
    /** Records an event at `at` (now when omitted; an earlier time is inserted in order: the
     *  buffers stay sorted by `t`); the recorded event (undefined once disposed). */
    event(kind: string, plugin: string, name: string, duration?: number | null, count?: number, window?: string, at?: number): PerfEvent | undefined;
    /** One observation of a metric ('tilr' `metric()`), made at `at` (now when omitted); see
     *  PerfMetric. Values are non-negative: invalid names, negative or non-finite values are counted
     *  in `dropped.invalid`; labels that are not strings are left out. */
    metric(name: string, value: number, labels?: Readonly<Record<string, string>>, at?: number): void;
    /** The series as PerfMetric, `recent` / `seconds` from `since` on. */
    metricList(since: number): PerfMetric[];
    /** An Event Timing entry, at its own `startTime` (when the input happened, not when the
     *  observer delivered it; buffered entries replayed at boot keep theirs). */
    private input;
    /** Cordis owns disposal of the wrapped callback; its unregister keeps the same identity.
     * Times only synchronous execution, not async waiting or subsequent promise continuations. */
    instrumentEvents(root: Context, owner: (ctx: Context) => string): void;
    private reactHook;
    private commit;
    /** How many React roots have a mounted tree now (the commits seen since collection started). */
    reactRoots(): number;
    /** Cordis listeners per plugin now (what samples carry as `listeners`). */
    listenerCounts(): Record<string, number>;
    /** The latest native process sample; [] when none arrived in the last 3 s. */
    latestProcesses(): ProcessMetric[];
    private sample;
    snapshot(since?: number): PerfRecording;
    metrics(): string;
    dispose(): void;
}
/**
 * A rendered component's own time: its actualDuration minus its children's, but only when the
 * children are from this commit. A fiber that bailed out on its children (`alternate.child ===
 * child`, React's own test in bubbleProperties) still points at the fibers of an earlier commit,
 * whose actualDuration is stale, and React did not add them to its own duration. Children the
 * fiber reconciled are fresh (createWorkInProgress resets their duration), host and memo
 * children included: their duration holds the work below them done in this commit.
 */
export declare function selfDuration(fiber: Fiber): number | null;
export {};
