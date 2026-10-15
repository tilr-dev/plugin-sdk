const PERFORMANCE_KEY = "tilr.performance.enabled";
const HISTORY = 12e4;
const SAMPLE_INTERVAL = 1e3;
const MAX_EVENTS = 2e4;
const MAX_HANDLER_EVENTS = 5e3;
const MAX_FIBERS = 2e4;
const FRAME_DEMAND_MS = 5e3;
const STALL_MS = 1500;
const MAX_SERIES = 512;
const METRIC_RING = 256;
const METRIC_SECONDS = 120;
const METRIC_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_LABELS = 8;
const MAX_LABEL_VALUE = 128;
const INPUT_TYPES = /* @__PURE__ */ new Set(["keydown", "keyup", "pointerdown", "pointerup", "click", "wheel"]);
const COMPONENT_TAGS = [0, 1, 11, 14, 15];
function renderReason(fiber) {
  const before = fiber.alternate;
  if (!before) return { reason: "mount", props: [], candidate: false };
  const props = [];
  const a = before.memoizedProps ?? {}, b = fiber.memoizedProps ?? {};
  const keys = [.../* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys.slice(0, 100)) if (!Object.is(a[key], b[key]) || Object.hasOwn(a, key) !== Object.hasOwn(b, key)) props.push(key.slice(0, 100));
  const reasons = props.length ? ["props changed (identity/value)"] : [];
  if (keys.length > 100) reasons.push("props comparison truncated");
  let stateChanged = false;
  if (fiber.tag === 1) stateChanged = !Object.is(before.memoizedState, fiber.memoizedState);
  else {
    let old = before.memoizedState, next = fiber.memoizedState;
    let n = 0;
    while (old && next && n++ < 100) {
      if ((old.queue || next.queue) && !Object.is(old.memoizedState, next.memoizedState)) stateChanged = true;
      old = old.next ?? null;
      next = next.next ?? null;
    }
    if (old || next) reasons.push("hooks changed or comparison incomplete");
  }
  if (stateChanged) reasons.push("state/reducer changed");
  let oldContext = before.dependencies?.firstContext, nextContext = fiber.dependencies?.firstContext;
  let contexts = 0;
  while (oldContext && nextContext && contexts++ < 100) {
    if (oldContext.context !== nextContext.context || !Object.is(oldContext.memoizedValue, nextContext.memoizedValue)) {
      reasons.push("context changed");
      break;
    }
    oldContext = oldContext.next;
    nextContext = nextContext.next;
  }
  if ((oldContext || nextContext) && !reasons.includes("context changed")) reasons.push("context comparison incomplete");
  const candidate = reasons.length === 0;
  return { reason: candidate ? "same observed inputs; parent update or unknown cause" : reasons.join("; "), props, candidate };
}
const globals = globalThis;
let performanceCollector;
function performanceRequested() {
  try {
    return sessionStorage.getItem(PERFORMANCE_KEY) === "on";
  } catch {
    return false;
  }
}
function requestPerformance(on) {
  sessionStorage.setItem(PERFORMANCE_KEY, on ? "on" : "off");
}
function bootPerformance() {
  if (globalThis.__tilrPerf) return;
  if (!performanceCollector && performanceRequested()) performanceCollector = new PerformanceCollector();
}
function stopPerformance() {
  performanceCollector?.dispose();
  performanceCollector = void 0;
}
function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
}
const label = (s) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
function insert(list, item) {
  if (!list.length || list[list.length - 1].t <= item.t) {
    list.push(item);
    return;
  }
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = lo + hi >>> 1;
    if (list[mid].t <= item.t) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, item);
}
function lowerBound(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = lo + hi >>> 1;
    if (list[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function coverage(m, from) {
  return m.count > METRIC_RING && m.recent.length >= METRIC_RING && m.recent[0][0] > from ? "tail" : "full";
}
function metricStats(m, end, window2 = 1e4) {
  const from = end - window2;
  const values = [];
  for (const [t, v] of m.recent) if (t > from && t <= end) values.push(v);
  const first = Math.ceil(from / 1e3), last = Math.floor(end / 1e3) - 1;
  let count = 0;
  for (const [second, n] of m.seconds) if (second >= first && second <= last) count += n;
  const seconds = last - first + 1;
  return { rate: seconds > 0 ? count / seconds : 0, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null, values, n: values.length, coverage: coverage(m, from) };
}
function metricExposition(metrics, now, window2 = 6e4) {
  const out = [];
  const stats = metrics.map((m) => metricStats(m, now, window2));
  const labels = (m) => [`name="${label(m.name)}"`, ...Object.entries(m.labels).map(([k, v]) => `${k}="${label(v)}"`)].join(",");
  const family = (name, type, value) => {
    out.push(`# TYPE ${name} ${type}`);
    for (const [i, m] of metrics.entries()) {
      const v = value(m, stats[i]);
      if (v !== null) out.push(`${name}{${labels(m)}} ${v}`);
    }
  };
  family("tilr_metric_count", "counter", (m) => m.count);
  family("tilr_metric_sum", "counter", (m) => m.sum);
  family("tilr_metric_p50", "gauge", (_, s) => s.p50);
  family("tilr_metric_p95", "gauge", (_, s) => s.p95);
  family("tilr_metric_max", "gauge", (_, s) => s.max);
  family("tilr_metric_n", "gauge", (_, s) => s.n || null);
  family("tilr_metric_tail", "gauge", (_, s) => s.n ? s.coverage === "tail" ? 1 : 0 : null);
  return out;
}
class Series {
  count = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;
  last = 0;
  t = 0;
  times = new Float64Array(METRIC_RING);
  values = new Float64Array(METRIC_RING);
  next = 0;
  size = 0;
  secondIds = new Float64Array(METRIC_SECONDS).fill(-1);
  secondCounts = new Float64Array(METRIC_SECONDS);
  secondSums = new Float64Array(METRIC_SECONDS);
  name;
  labels;
  constructor(name, labels) {
    this.name = name;
    this.labels = labels;
  }
  /** `t` is when the observation happened, which may be earlier than the previous one's (an
   *  Event Timing entry's startTime): the ring is sorted when read, and a second older than the
   *  buckets reach back is left out of them (never overwrites a newer one). */
  add(t, value) {
    this.count++;
    this.sum += value;
    if (t >= this.t) {
      this.last = value;
      this.t = t;
    }
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    this.times[this.next] = t;
    this.values[this.next] = value;
    this.next = (this.next + 1) % METRIC_RING;
    if (this.size < METRIC_RING) this.size++;
    const second = Math.floor(t / 1e3), slot = (second % METRIC_SECONDS + METRIC_SECONDS) % METRIC_SECONDS;
    if (this.secondIds[slot] > second) return;
    if (this.secondIds[slot] !== second) {
      this.secondIds[slot] = second;
      this.secondCounts[slot] = 0;
      this.secondSums[slot] = 0;
    }
    this.secondCounts[slot]++;
    this.secondSums[slot] += value;
  }
  view(since, now) {
    const recent = [];
    let sorted = true;
    for (let i = 0; i < this.size; i++) {
      const at = (this.next - this.size + i + METRIC_RING) % METRIC_RING;
      if (this.times[at] >= since) {
        if (recent.length && recent[recent.length - 1][0] > this.times[at]) sorted = false;
        recent.push([this.times[at], this.values[at]]);
      }
    }
    if (!sorted) recent.sort((a, b) => a[0] - b[0]);
    const seconds = [];
    const last = Math.floor(now / 1e3);
    for (let second = Math.max(Math.floor(since / 1e3), last - METRIC_SECONDS + 1); second <= last; second++) {
      const slot = (second % METRIC_SECONDS + METRIC_SECONDS) % METRIC_SECONDS;
      if (this.secondIds[slot] === second && this.secondCounts[slot]) seconds.push([second, this.secondCounts[slot], this.secondSums[slot]]);
    }
    return { name: this.name, labels: { ...this.labels }, count: this.count, sum: this.sum, min: this.min, max: this.max, last: this.last, t: this.t, recent, seconds };
  }
}
class PerformanceCollector {
  origin = performance.timeOrigin;
  started = performance.now();
  samples = [];
  /** Everything but Cordis handler calls, bounded to MAX_EVENTS (20,000), sorted by `t`. */
  events = [];
  /** Cordis handler calls (`handler`), bounded to MAX_HANDLER_EVENTS (5,000), sorted by `t`. */
  handlers = [];
  marks = /* @__PURE__ */ new Map();
  totals = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  /** Metric series by name + sorted labels. */
  series = /* @__PURE__ */ new Map();
  /** Everything the bounded buffers dropped in this session, by kind (see PerfRecording). */
  dropped = {};
  analysisPlugin = null;
  highlight = false;
  dropLog = [];
  fiberIDs = /* @__PURE__ */ new WeakMap();
  nextFiberID = 1;
  flashes = [];
  flashPending = [];
  flashFrame = 0;
  flashTimer;
  analyze(plugin, highlight = false) {
    this.analysisPlugin = plugin;
    this.highlight = !!plugin && highlight;
    this.fiberIDs = /* @__PURE__ */ new WeakMap();
    this.clearHighlights();
  }
  clearHighlights() {
    if (this.flashTimer !== void 0) clearTimeout(this.flashTimer);
    this.flashTimer = void 0;
    if (this.flashFrame) cancelAnimationFrame(this.flashFrame);
    this.flashFrame = 0;
    this.flashPending = [];
    for (const el of this.flashes) el.remove();
    this.flashes = [];
  }
  fiberID(fiber) {
    const id = this.fiberIDs.get(fiber) ?? (fiber.alternate && this.fiberIDs.get(fiber.alternate)) ?? this.nextFiberID++;
    this.fiberIDs.set(fiber, id);
    return id;
  }
  /** Notes the rendered host element during the commit; its rectangle is read after the commit,
   *  in the next frame, never inside React's commit hook (that would force a layout there). */
  flash(fiber) {
    if (this.flashes.length + this.flashPending.length >= 20) return;
    const queue = [fiber];
    let n = 0;
    while (queue.length && n++ < 100) {
      const item = queue.pop();
      if (!item) continue;
      if (item.stateNode instanceof Element) {
        this.flashPending.push(item.stateNode);
        if (!this.flashFrame) this.flashFrame = requestAnimationFrame(() => this.drawFlashes());
        return;
      }
      for (let child = item.child, count = 0; child && count++ < 100; child = child.sibling) queue.push(child);
    }
  }
  drawFlashes() {
    this.flashFrame = 0;
    const pending = this.flashPending;
    this.flashPending = [];
    if (this.disposed || !this.highlight) return;
    for (const el of pending) {
      if (!el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      const box = document.createElement("div");
      box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff8c00;box-sizing:border-box;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
      document.body.append(box);
      this.flashes.push(box);
    }
    if (this.flashTimer !== void 0) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.clearHighlights(), 180);
  }
  frame = 0;
  framing = false;
  frameFrom = 0;
  frameUntil = 0;
  demands = /* @__PURE__ */ new Map();
  timer;
  lastFrame = 0;
  lastSample = this.started;
  deltas = [];
  intervalCommits = 0;
  intervalRender = 0;
  pending = false;
  disposed = false;
  processes = [];
  processAt = 0;
  replyAt = 0;
  observers = [];
  lagChannel;
  lagSent = null;
  restoreHook;
  restoreEvents;
  subscriptions = () => ({});
  frameBuckets = [0, 0, 0, 0, 0, 0];
  frameSum = 0;
  frameCount = 0;
  /** React roots whose last commit left a tree (an unmount commits an empty one). */
  roots = /* @__PURE__ */ new Set();
  visibility = () => {
    this.lastFrame = 0;
    this.frameFrom = 0;
    this.deltas = [];
    this.lastSample = performance.now();
    this.replyAt = 0;
  };
  constructor() {
    this.restoreHook = this.reactHook();
    if (typeof PerformanceObserver !== "undefined") {
      const supported = PerformanceObserver.supportedEntryTypes;
      for (const type of ["resource", "navigation", "mark", "measure", "event"]) {
        if (!supported.includes(type)) continue;
        try {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (this.disposed) return;
              if (type === "event") this.input(entry);
              else this.event(type, "page", entry.name.split(/[?#]/)[0], entry.duration);
            }
          });
          observer.observe(type === "event" ? { type, buffered: true, durationThreshold: 16 } : { type, buffered: true });
          this.observers.push(observer);
        } catch {
        }
      }
    }
    if (typeof window !== "undefined" && typeof MessageChannel !== "undefined") {
      this.lagChannel = new MessageChannel();
      this.lagChannel.port1.onmessage = () => {
        if (!this.disposed && this.lagSent !== null) this.event("lag", "page", "Main-thread task delay", performance.now() - this.lagSent);
        this.lagSent = null;
      };
    }
    document.addEventListener("visibilitychange", this.visibility);
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL);
  }
  /**
   * Something that reads frame data starts (`on`) or stops needing it: `'window'` (the
   * Performance window is open), `'recording'`. Counted per reason. See FRAME_DEMAND_MS.
   */
  demand(reason, on) {
    const n = (this.demands.get(reason) ?? 0) + (on ? 1 : -1);
    if (n > 0) this.demands.set(reason, n);
    else this.demands.delete(reason);
    this.frames();
  }
  /** Whether the rAF loop runs now. */
  get framesOn() {
    return this.framing;
  }
  wantsFrames() {
    return !this.disposed && (this.demands.size > 0 || performance.now() < this.frameUntil);
  }
  frames() {
    if (!this.wantsFrames()) {
      this.stopFrames();
      return;
    }
    if (this.framing) return;
    this.framing = true;
    this.lastFrame = 0;
    this.frameFrom = 0;
    this.deltas = [];
    this.frame = requestAnimationFrame(this.tick);
  }
  stopFrames() {
    if (this.framing) cancelAnimationFrame(this.frame);
    this.framing = false;
    this.frame = 0;
    this.lastFrame = 0;
    this.frameFrom = 0;
    this.deltas = [];
  }
  tick = (t) => {
    if (!this.framing) return;
    if (!this.wantsFrames()) {
      this.framing = false;
      this.frame = 0;
      this.lastFrame = 0;
      this.frameFrom = 0;
      this.deltas = [];
      return;
    }
    if (this.lastFrame && document.visibilityState === "visible") {
      const delta = t - this.lastFrame;
      this.deltas.push(delta);
      const seconds = delta / 1e3;
      this.frameSum += seconds;
      this.frameCount++;
      [834e-5, 0.01667, 0.025, 0.05, 0.1, Infinity].forEach((bound, i) => {
        if (seconds <= bound) this.frameBuckets[i]++;
      });
      if (delta > 50) this.event("frame", "page", "Long frame interval", delta);
    } else this.frameFrom = t;
    this.lastFrame = t;
    this.frame = requestAnimationFrame(this.tick);
  };
  total(plugin) {
    let total = this.totals.get(plugin);
    if (!total) {
      total = { commits: 0, renders: 0, renderMs: 0, loads: 0, reloads: 0, starts: 0, errors: 0, operationMs: 0, handlers: 0, handlerMs: 0, loadMs: 0, loadBuckets: [0, 0, 0, 0, 0, 0] };
      this.totals.set(plugin, total);
    }
    return total;
  }
  /** Counts `n` dropped items of `kind`, for the session and for recordings (by time). */
  drop(kind, n) {
    if (!n) return;
    this.dropped[kind] = (this.dropped[kind] ?? 0) + n;
    const t = performance.now();
    const last = this.dropLog.at(-1);
    if (last && last.kind === kind && t - last.t < 1e3) last.n += n;
    else this.dropLog.push({ t, kind, n });
  }
  /** Records an event at `at` (now when omitted; an earlier time is inserted in order: the
   *  buffers stay sorted by `t`); the recorded event (undefined once disposed). */
  event(kind, plugin, name, duration = null, count, window2, at) {
    if (this.disposed) return;
    plugin = plugin.slice(0, 128);
    if (!this.totals.has(plugin) && this.totals.size >= 511) plugin = "other";
    name = name.slice(0, 512);
    const t = at ?? performance.now();
    const event = { t, kind, plugin, name, duration, ...count === void 0 ? {} : { count }, ...window2 ? { window: window2 } : {} };
    if (kind === "handler") {
      insert(this.handlers, event);
      if (this.handlers.length > MAX_HANDLER_EVENTS) {
        const trim = MAX_HANDLER_EVENTS / 4;
        this.handlers.splice(0, trim);
        this.drop("handler", trim);
      }
    } else {
      insert(this.events, event);
      if (this.events.length > MAX_EVENTS) {
        const removed = this.events.splice(0, MAX_EVENTS / 4);
        const kinds = /* @__PURE__ */ new Map();
        for (const e of removed) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
        for (const [k, n] of kinds) this.drop(k, n);
      }
    }
    if (kind === "mark") {
      this.marks.delete(name);
      this.marks.set(name, t);
      if (this.marks.size > 512) {
        const first = this.marks.keys().next().value;
        if (first !== void 0) this.marks.delete(first);
      }
    }
    const total = this.total(plugin);
    if (kind === "load") total.loads++;
    if (kind === "reload") total.reloads++;
    if ((kind === "load" || kind === "reload") && duration !== null) {
      total.loadMs += duration;
      [1e-3, 0.01, 0.1, 1, 5, Infinity].forEach((bound, i) => {
        if (duration / 1e3 <= bound) total.loadBuckets[i]++;
      });
    }
    if (kind === "start") total.starts++;
    if (kind === "error") total.errors++;
    if (kind === "operation") total.operationMs += duration ?? 0;
    if (kind === "handler") {
      total.handlers++;
      total.handlerMs += duration ?? 0;
    }
    return event;
  }
  /** One observation of a metric ('tilr' `metric()`), made at `at` (now when omitted); see
   *  PerfMetric. Values are non-negative: invalid names, negative or non-finite values are counted
   *  in `dropped.invalid`; labels that are not strings are left out. */
  metric(name, value, labels, at) {
    if (this.disposed) return;
    if (typeof name !== "string" || name.length > 128 || !METRIC_NAME.test(name) || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      this.drop("invalid", 1);
      return;
    }
    let key = name;
    let clean;
    if (labels && typeof labels === "object") {
      const keys = Object.keys(labels).filter((k) => typeof labels[k] === "string" && k !== "name" && !k.startsWith("__") && LABEL_NAME.test(k)).sort().slice(0, MAX_LABELS);
      if (keys.length) {
        clean = {};
        for (const k of keys) {
          const v = labels[k].slice(0, MAX_LABEL_VALUE);
          clean[k] = v;
          key += `\0${k}${v}`;
        }
      }
    }
    let series = this.series.get(key);
    if (!series) {
      if (this.series.size >= MAX_SERIES) {
        this.drop("series", 1);
        return;
      }
      series = new Series(name, Object.freeze(clean ?? {}));
      this.series.set(key, series);
    }
    series.add(at ?? performance.now(), value);
  }
  /** The series as PerfMetric, `recent` / `seconds` from `since` on. */
  metricList(since) {
    const now = performance.now();
    return [...this.series.values()].map((s) => s.view(since, now));
  }
  /** An Event Timing entry, at its own `startTime` (when the input happened, not when the
   *  observer delivered it; buffered entries replayed at boot keep theirs). */
  input(entry) {
    if (!INPUT_TYPES.has(entry.name)) return;
    const t = entry.startTime;
    const delay = Math.max(0, entry.processingStart - t);
    const processing = Math.max(0, entry.processingEnd - entry.processingStart);
    const event = this.event("input", "page", entry.name, entry.duration, void 0, void 0, t);
    if (event) event.input = { type: entry.name, delay, processing };
    const labels = { type: entry.name };
    this.metric("input.delay", delay, labels, t);
    this.metric("input.processing", processing, labels, t);
    this.metric("input.duration", entry.duration, labels, t);
  }
  /** Cordis owns disposal of the wrapped callback; its unregister keeps the same identity.
   * Times only synchronous execution, not async waiting or subsequent promise continuations. */
  instrumentEvents(root, owner) {
    if (this.restoreEvents) return;
    const service = root.events;
    const original = service.register;
    this.subscriptions = () => {
      const counts = /* @__PURE__ */ Object.create(null);
      for (const [name, hooks] of Object.entries(service._hooks)) {
        if (name.startsWith("internal/")) continue;
        for (const hook of hooks) {
          const plugin = owner(hook.ctx);
          counts[plugin] = (counts[plugin] ?? 0) + 1;
        }
      }
      return counts;
    };
    const run = (ctx, label2, callback, receiver, args) => {
      if (this.disposed) return callback.apply(receiver, args);
      const start = performance.now();
      try {
        return callback.apply(receiver, args);
      } finally {
        this.event("handler", owner(ctx), label2, performance.now() - start);
      }
    };
    const wrapped = function(label2, hooks, callback, options) {
      if (label2.includes("internal/")) return original.call(this, label2, hooks, callback, options);
      const ctx = this.ctx;
      const measured = function(...args) {
        return run(ctx, label2, callback, this, args);
      };
      return original.call(this, label2, hooks, measured, options);
    };
    service.register = wrapped;
    this.restoreEvents = () => {
      if (service.register === wrapped) service.register = original;
    };
  }
  reactHook() {
    const existing = globals.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const hook = existing ?? { supportsFiber: true, renderers: /* @__PURE__ */ new Map(), inject(renderer) {
      const id = (this.renderers?.size ?? 0) + 1;
      this.renderers?.set(id, renderer);
      return id;
    } };
    const original = hook.onCommitFiberRoot;
    const callback = (id, root, ...rest) => {
      if (!this.disposed) {
        try {
          this.commit(root);
        } catch {
        }
      }
      original?.call(hook, id, root, ...rest);
    };
    hook.onCommitFiberRoot = callback;
    globals.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    return () => {
      if (hook.onCommitFiberRoot === callback) hook.onCommitFiberRoot = original;
      if (!existing && globals.__REACT_DEVTOOLS_GLOBAL_HOOK__ === hook) delete globals.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    };
  }
  commit(root) {
    const top = root.current;
    if (!top) return;
    if (top.child) this.roots.add(root);
    else this.roots.delete(root);
    const container = root.containerInfo;
    const host = container instanceof Element ? container.closest("[data-perf-plugin]") : null;
    const plugin = host?.dataset.perfPlugin ?? "unattributed";
    const window2 = host?.dataset.perfWindow;
    const duration = typeof top.actualDuration === "number" ? top.actualDuration : null;
    this.intervalCommits++;
    this.intervalRender += duration ?? 0;
    const total = this.total(plugin);
    total.commits++;
    total.renderMs += duration ?? 0;
    this.event("react", plugin, "React commit", duration, void 0, window2);
    const detailed = plugin === this.analysisPlugin;
    const stack = [{ fiber: top, parent: null, depth: 0 }];
    let visited = 0;
    const components = /* @__PURE__ */ new Map();
    while (stack.length && visited++ < MAX_FIBERS) {
      const item = stack.pop();
      if (!item) continue;
      const { fiber, parent, depth } = item;
      let nextParent = parent, nextDepth = depth;
      if (COMPONENT_TAGS.includes(fiber.tag) && fiber.flags & 1) {
        const name = fiber.type?.displayName ?? fiber.type?.name ?? "Anonymous";
        components.set(name, (components.get(name) ?? 0) + 1);
        total.renders++;
        if (detailed) {
          const id = this.fiberID(fiber);
          const detail = { id, parent, depth, ...renderReason(fiber), selfMs: selfDuration(fiber) };
          const event = this.event("render-detail", plugin, name, fiber.actualDuration ?? null, void 0, window2);
          if (event) event.detail = detail;
          if (this.highlight) this.flash(fiber);
        }
      }
      if (detailed && COMPONENT_TAGS.includes(fiber.tag)) {
        nextParent = this.fiberID(fiber);
        nextDepth++;
      }
      if (fiber.sibling) stack.push({ fiber: fiber.sibling, parent, depth });
      if (fiber.child && (fiber.subtreeFlags === void 0 || fiber.subtreeFlags & 1)) stack.push({ fiber: fiber.child, parent: nextParent, depth: nextDepth });
    }
    for (const [name, count] of components) this.event("component", plugin, name, null, count, window2);
    if (stack.length) this.event("limit", plugin, "Component traversal truncated");
  }
  /** How many React roots have a mounted tree now (the commits seen since collection started). */
  reactRoots() {
    for (const root of this.roots) if (!root.current?.child) this.roots.delete(root);
    return this.roots.size;
  }
  /** Cordis listeners per plugin now (what samples carry as `listeners`). */
  listenerCounts() {
    return this.subscriptions();
  }
  /** The latest native process sample; [] when none arrived in the last 3 s. */
  latestProcesses() {
    return performance.now() - this.processAt < 3e3 ? this.processes : [];
  }
  sample() {
    const t = performance.now();
    if (this.lagChannel && this.lagSent === null) {
      this.lagSent = t;
      this.lagChannel.port2.postMessage(null);
    }
    const visible = document.visibilityState === "visible";
    const from = Math.max(this.lastSample, this.frameFrom);
    const framed = visible && this.framing && this.frameFrom > 0 && t - from >= 250;
    const sample = {
      t,
      visible,
      fps: framed ? this.deltas.length * 1e3 / (t - from) : null,
      frameP95: framed ? percentile(this.deltas, 0.95) : null,
      frameMax: framed ? percentile(this.deltas, 1) : null,
      commits: this.intervalCommits,
      renderMs: this.intervalRender,
      processes: t - this.processAt < 3e3 ? this.processes : [],
      listeners: this.subscriptions()
    };
    this.samples.push(sample);
    while (this.samples.length && this.samples[0].t < t - HISTORY) this.samples.shift();
    for (const list of [this.events, this.handlers]) {
      const first = lowerBound(list, t - HISTORY);
      if (first > 0) list.splice(0, first);
    }
    const old = lowerBound(this.dropLog, t - HISTORY);
    if (old > 0) this.dropLog.splice(0, old);
    this.lastSample = t;
    this.deltas = [];
    this.intervalCommits = 0;
    this.intervalRender = 0;
    const bridge = globals.webkit?.messageHandlers?.tilrPerformance;
    if (bridge && !this.pending) {
      this.pending = true;
      void bridge.postMessage("sample").then((processes) => {
        if (this.disposed) return;
        const now = performance.now();
        if (this.replyAt && now - this.replyAt > STALL_MS && document.visibilityState === "visible") {
          const last = this.samples.at(-1);
          if (last) {
            last.late = true;
            last.gap = now - this.replyAt;
          }
        }
        this.replyAt = now;
        this.processes = processes;
        this.processAt = now;
      }).catch(() => {
        this.processes = [];
      }).finally(() => {
        this.pending = false;
      });
    }
    for (const listener of this.listeners) listener();
    this.event("operation", "performance", "Sample and display", performance.now() - t);
  }
  snapshot(since = this.started) {
    const now = performance.now();
    const started = Math.max(since, now - HISTORY);
    const dropped = {};
    for (const d of this.dropLog) if (d.t >= started) dropped[d.kind] = (dropped[d.kind] ?? 0) + d.n;
    const events = [];
    const a = this.events, b = this.handlers;
    for (let i = lowerBound(a, since), j = lowerBound(b, since); i < a.length || j < b.length; ) {
      const e = j >= b.length || i < a.length && a[i].t <= b[j].t ? a[i++] : b[j++];
      events.push({ ...e });
    }
    return {
      version: 1,
      origin: this.origin,
      react: "dev",
      started,
      ended: now,
      samples: this.samples.filter((s) => s.t >= since).map((s) => ({ ...s, processes: s.processes.map((p) => ({ ...p })) })),
      events,
      dropped,
      metrics: this.metricList(started)
    };
  }
  metrics() {
    this.frameUntil = performance.now() + FRAME_DEMAND_MS;
    this.frames();
    const out = ["# TYPE tilr_performance_enabled gauge", "tilr_performance_enabled 1"];
    const emit = (name, type, rows) => {
      out.push(`# TYPE ${name} ${type}`);
      for (const [labels, value] of rows) out.push(`${name}${labels ? "{" + labels + "}" : ""} ${value}`);
    };
    for (const [name, key, divisor] of [
      ["tilr_react_commits_total", "commits", 1],
      ["tilr_react_component_renders_total", "renders", 1],
      ["tilr_react_render_seconds_total", "renderMs", 1e3],
      ["tilr_plugin_loads_total", "loads", 1],
      ["tilr_plugin_reloads_total", "reloads", 1],
      ["tilr_plugin_starts_total", "starts", 1],
      ["tilr_plugin_errors_total", "errors", 1],
      ["tilr_plugin_operation_seconds_total", "operationMs", 1e3],
      ["tilr_plugin_handler_calls_total", "handlers", 1],
      ["tilr_plugin_handler_seconds_total", "handlerMs", 1e3]
    ]) {
      if (key === "renderMs" && false) continue;
      emit(name, "counter", [...this.totals].map(([plugin, total]) => [`plugin="${label(plugin)}"`, total[key] / divisor]));
    }
    emit("tilr_react_timing_available", "gauge", [["", false ? 0 : 1]]);
    out.push("# TYPE tilr_plugin_load_duration_seconds histogram");
    for (const [plugin, total] of this.totals) {
      const labels = `plugin="${label(plugin)}"`;
      ["0.001", "0.01", "0.1", "1", "5", "+Inf"].forEach((bound, i) => out.push(`tilr_plugin_load_duration_seconds_bucket{${labels},le="${bound}"} ${total.loadBuckets[i]}`));
      out.push(`tilr_plugin_load_duration_seconds_sum{${labels}} ${total.loadMs / 1e3}`, `tilr_plugin_load_duration_seconds_count{${labels}} ${total.loads + total.reloads}`);
    }
    out.push("# TYPE tilr_frame_interval_seconds histogram");
    ["0.00834", "0.01667", "0.025", "0.05", "0.1", "+Inf"].forEach((bound, i) => out.push(`tilr_frame_interval_seconds_bucket{le="${bound}"} ${this.frameBuckets[i]}`));
    out.push(`tilr_frame_interval_seconds_sum ${this.frameSum}`, `tilr_frame_interval_seconds_count ${this.frameCount}`);
    const sample = this.samples.at(-1);
    if (sample) {
      emit("tilr_plugin_event_listeners", "gauge", Object.entries(sample.listeners ?? {}).map(([plugin, count]) => [`plugin="${label(plugin)}"`, count]));
      emit("tilr_sample_timestamp_seconds", "gauge", [["", (this.origin + sample.t) / 1e3]]);
      emit("tilr_page_visible", "gauge", [["", document.visibilityState === "visible" ? 1 : 0]]);
      if (sample.fps !== null && document.visibilityState === "visible" && performance.now() - sample.t < 3e3) emit("tilr_fps", "gauge", [["", sample.fps]]);
      const processes = performance.now() - sample.t < 3e3 ? sample.processes : [];
      const rows = (key) => processes.map((p) => [`role="${label(p.name)}",scope="${label(p.scope)}",pid="${p.pid}"`, p[key]]);
      emit("tilr_process_memory_bytes", "gauge", rows("memory"));
      emit("tilr_process_cpu_seconds_total", "counter", rows("cpuSeconds"));
    }
    const drops = Object.entries(this.dropped);
    emit("tilr_performance_dropped_events_total", "counter", drops.filter(([kind]) => kind !== "series" && kind !== "invalid").map(([kind, n]) => [`kind="${label(kind)}"`, n]));
    emit("tilr_metric_dropped_total", "counter", ["series", "invalid"].map((reason) => [`reason="${reason}"`, this.dropped[reason] ?? 0]));
    const now = performance.now();
    out.push(...metricExposition(this.metricList(now - 6e4), now));
    return out.join("\n") + "\n";
  }
  dispose() {
    this.disposed = true;
    this.analyze(null);
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    this.lagChannel?.port1.close();
    this.lagChannel?.port2.close();
    this.lagChannel = void 0;
    clearInterval(this.timer);
    this.stopFrames();
    this.demands.clear();
    document.removeEventListener("visibilitychange", this.visibility);
    this.restoreHook();
    this.restoreEvents?.();
    this.subscriptions = () => ({});
    this.listeners.clear();
    this.samples.length = 0;
    this.events.length = 0;
    this.handlers.length = 0;
    this.totals.clear();
    this.marks.clear();
    this.deltas = [];
    this.processes = [];
    this.series.clear();
    this.dropLog = [];
    this.roots.clear();
    void globals.webkit?.messageHandlers?.tilrPerformance?.postMessage("reset").catch(() => {
    });
  }
}
function selfDuration(fiber) {
  if (typeof fiber.actualDuration !== "number") return null;
  let self = fiber.actualDuration;
  if (!fiber.alternate || fiber.alternate.child !== fiber.child) {
    for (let child = fiber.child, n = 0; child && n++ < MAX_FIBERS; child = child.sibling) self -= child.actualDuration ?? 0;
  }
  return Math.max(0, self);
}
export {
  FRAME_DEMAND_MS,
  HISTORY,
  MAX_SERIES,
  METRIC_RING,
  PERFORMANCE_KEY,
  PerformanceCollector,
  SAMPLE_INTERVAL,
  STALL_MS,
  bootPerformance,
  coverage,
  lowerBound,
  metricExposition,
  metricStats,
  percentile,
  performanceCollector,
  performanceRequested,
  renderReason,
  requestPerformance,
  selfDuration,
  stopPerformance
};
//# sourceMappingURL=performance.js.map
