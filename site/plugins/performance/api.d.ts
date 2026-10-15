/** Optional diagnostics service. Collection starts disabled; switching it reloads the page. */
export interface Performance {
  /** Optional expensive analysis of one plugin; null disables it. Reasons are inferred. */
  analyze(plugin: string | null, highlight?: boolean): void
  readonly enabled: boolean
  /** A record() is in progress (until finish() or the 60 s auto-stop). */
  readonly recording: boolean
  /** How far back the live history (samples, events, metric buckets) reaches: 120000 ms. */
  readonly history: number
  /** The sampler's period (process CPU / memory, FPS, React counts per sample): 1000 ms. */
  readonly sampleInterval: number
  /** Open/focus the singleton diagnostics window. */
  open(): void
  /** Change this tab's collection mode, preserve the recording, then reload. */
  enable(on: boolean): Promise<void>
  /** Prometheus exposition. Disabled collection returns only its disabled status. */
  metrics(): string
  /** Bounded JSON-compatible recording, or null while disabled: format version 1 with
   *  `samples`, `events`, `dropped` (by kind) and `metrics` (PerfMetric[], what 'tilr' metric()
   *  observed; see README, Performance plugin). */
  snapshot(): PerfRecording | null
  /** The metric series of the live history: snapshot().metrics without copying samples and
   *  events. null while disabled. */
  series(): PerfMetric[] | null
  /** Counts that tell where memory growth comes from (`tilr ctl debug memory`), cheap: no
   *  copies of the buffers. null while disabled. */
  probe(): PerformanceProbe | null
  /** The Mac app's memory breakdown per process (WebContent of the page, Tilr): footprint and
   *  categories in bytes, ~100–300 ms of native work: call it on demand, never on a timer. null
   *  where the native bridge is missing or too old to answer (a browser, an older Mac app).
   *  Works with collection off. */
  footprint(): Promise<FootprintReply | null>
  /** Asks WebKit to release what it can (caches, uncollected garbage): `before` / `after` are the
   *  WebContent footprint. May be system-wide (a low-memory notification other processes get
   *  too). null where the bridge cannot (see footprint()). */
  squeeze(): Promise<SqueezeReply | null>
  /** Opens Safari Web Inspector for the page; true when it was shown, false otherwise (no
   *  bridge, an older Mac app, or the app declined). */
  inspector(): Promise<boolean>
  /** Start recording; auto-stops at 60 seconds. Requires enabled collection. `persist: false`
   *  (a tool's recording): finish() returns it without replacing the saved recording. */
  record(options?: { persist?: boolean }): void
  /** Stop and return the recording: the same version-1 shape as snapshot(), its samples,
   *  events, dropped and metrics' `recent` / `seconds` cut to the recording's window (metric
   *  count / sum / min / max / last stay session totals); preserved for review / export unless
   *  record() had `persist: false`. null when no recording was in progress. */
  finish(): PerfRecording | null
}

/** What probe() answers. */
export interface PerformanceProbe {
  /** performance.now() of the page. */
  t: number
  /** The latest native process sample (none older than 3 s): role WebContent / Tilr, memory
   *  bytes (physical footprint), cpu % of a core (null on a process' first sample). */
  processes: { role: string; scope: string; pid: number; memory: number; cpu: number | null }[]
  /** Mounted windows (the window registry). */
  windows: number
  /** document.getElementsByTagName('*').length */
  domNodes: number
  /** Cordis event listeners: their total and per plugin. */
  listeners: { total: number; byPlugin: Record<string, number> }
  /** React roots with a mounted tree. */
  reactRoots: number
  canvases: number
  images: number
}

/** footprint()'s memory categories, bytes. */
export interface FootprintCategories {
  /** WebKit's malloc heaps (bmalloc, libpas): DOM, style, caches, garbage not yet scavenged. */
  malloc: number
  /** IOSurface / GPU memory: compositing layers and their tiles, canvases, images on the GPU. */
  graphics: number
  /** The JS heap (Gigacage, JSC's own allocations). */
  js: number
  /** JIT code. */
  jit: number
  other: number
}
/** One process of footprint(). */
export interface FootprintProcess {
  pid: number
  /** 'webcontent' (the page's) or 'tilr' (the app). */
  role: string
  scope: string
  /** Physical footprint, bytes. */
  footprint: number
  /** What the process marked reclaimable (purgeable), bytes. */
  reclaimable: number
  categories: FootprintCategories
}
export interface FootprintReply {
  processes: FootprintProcess[]
  /** How long the native side took, ms. */
  took: number
  error?: string
}
export interface SqueezeReply {
  /** How the app asked WebKit to release memory (e.g. a low-memory notification). */
  method: string
  /** WebContent footprint before and after, bytes. */
  before: number
  after: number
}

/** A recording, format version 1 (the full declarations: 'tilr' api/performance.d.ts). Times
 *  are the page's performance.now() ms; `origin` is its timeOrigin. */
export interface PerfRecording {
  version: 1
  origin: number
  /** The React build: dev, profiling or prod. */
  react: string
  started: number
  ended: number
  /** One per sampleInterval: t, visible, fps (null: no frame loop), frameP95, frameMax, commits,
   *  renderMs, processes ({ pid, name, scope, cpu (% of a core, null on the first), cpuSeconds,
   *  memory (bytes) }[]), late / gap (a main-thread stall). */
  samples: unknown[]
  events: unknown[]
  /** What bounded buffers dropped inside the window, by kind. */
  dropped: Record<string, number>
  metrics?: PerfMetric[]
}
/** One metric() series: count / sum / min / max / last over the collection session, `recent`
 *  ([t, value], at most 256) and `seconds` ([second, count, sum]) inside the recording. */
export interface PerfMetric {
  name: string
  labels: Record<string, string>
  count: number
  sum: number
  min: number
  max: number
  last: number
  t: number
  recent: [number, number][]
  seconds: [number, number, number][]
}
