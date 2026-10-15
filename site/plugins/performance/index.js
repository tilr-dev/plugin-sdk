import { Service } from "cordis";
import { HISTORY, lowerBound, MAX_SERIES, METRIC_RING, metricStats, performanceCollector, requestPerformance, SAMPLE_INTERVAL, stopPerformance, percentile } from "../../performance.js";
import { reactMode } from "tilr";
const MAX_RECORDED_EVENTS = 25e3;
const METRIC_WINDOW = 1e4;
const css = `
.perf { padding:12px; display:flex; flex-direction:column; gap:12px; overflow:auto; height:100%; box-sizing:border-box; }
.perf .toolbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.perf button,.perf select,.perf input { font:inherit; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:4px 8px; }
.perf button:disabled { opacity:.5; }
.perf .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(125px,1fr)); gap:8px; }
.perf .metric { padding:10px; border:1px solid var(--line); border-radius:var(--radius); }
.perf .value { font-size:21px; font-variant-numeric:tabular-nums; }
.perf .muted { color:var(--muted); font-size:11px; }
.perf table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
.perf th,.perf td { text-align:left; padding:5px; border-bottom:1px solid var(--line); }
.perf th { color:var(--muted); font-weight:normal; }
.perf .chart { width:100%; height:70px; color:var(--accent); }
.perf .error { color:var(--accent); }
.perf .scroll { overflow:auto; max-height:260px; }
.perf summary { cursor:pointer; }
.perf .chart .stall { stroke:#e5484d; stroke-width:2; }
.perf .hops { display:flex; flex-direction:column; gap:2px; white-space:nowrap; }
.perf .swatch { display:inline-block; width:8px; height:8px; margin-right:4px; border-radius:2px; }
.perf .bar { display:flex; height:12px; min-width:160px; background:var(--line); border-radius:2px; overflow:hidden; }
.perf .bar span { height:100%; }
`;
const setText = (element, value2) => {
  if (element.textContent !== value2) element.textContent = value2;
};
const setAttribute = (element, name, value2) => {
  if (element.getAttribute(name) !== value2) element.setAttribute(name, value2);
};
const number = (n, digits = 1) => n == null ? "—" : n.toFixed(digits);
const memory = (s) => s?.processes.filter((p) => p.name === "WebContent").reduce((sum, p) => sum + p.memory, 0);
const cpu = (s) => {
  const rows = s?.processes.filter((p) => p.name === "WebContent") ?? [];
  return rows.length && rows.every((p) => p.cpu !== null) ? rows.reduce((sum, p) => sum + (p.cpu ?? 0), 0) : null;
};
const text = (tag, value2, cls) => {
  const el = document.createElement(tag);
  el.textContent = value2;
  if (cls) el.className = cls;
  return el;
};
function nativeFiles() {
  return globalThis.webkit?.messageHandlers?.tilrPerformance;
}
async function nativeRequest(type) {
  const bridge = nativeFiles();
  if (!bridge) return void 0;
  try {
    return await bridge.postMessage({ type });
  } catch {
    return void 0;
  }
}
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const bytes = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
function footprintReply(value2) {
  if (!isObject(value2) || !Array.isArray(value2.processes)) return null;
  const processes = value2.processes.filter(isObject).filter((p) => typeof p.footprint === "number").map((p) => {
    const c = isObject(p.categories) ? p.categories : {};
    return {
      pid: typeof p.pid === "number" ? p.pid : 0,
      role: String(p.role ?? ""),
      scope: String(p.scope ?? ""),
      footprint: bytes(p.footprint),
      reclaimable: bytes(p.reclaimable),
      categories: { malloc: bytes(c.malloc), graphics: bytes(c.graphics), js: bytes(c.js), jit: bytes(c.jit), other: bytes(c.other) }
    };
  });
  return { processes, took: typeof value2.took === "number" ? value2.took : 0, ...typeof value2.error === "string" ? { error: value2.error } : {} };
}
function squeezeReply(value2) {
  if (!isObject(value2) || typeof value2.before !== "number" || typeof value2.after !== "number") return null;
  return { method: String(value2.method ?? ""), before: value2.before, after: value2.after };
}
async function save(name, contents) {
  const native = nativeFiles();
  if (native) {
    await native.postMessage({ op: "save", name, contents });
    return;
  }
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function parseRecording(source) {
  if (source.length > 2e7) throw new Error("Recording exceeds 20 MB");
  const data = JSON.parse(source);
  const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const counts = (v) => object(v) && Object.keys(v).length <= 1e3 && Object.values(v).every(finite);
  if (!object(data) || data.version !== 1 || !finite(data.origin) || !finite(data.started) || !finite(data.ended) || data.ended < data.started || !(finite(data.dropped) || counts(data.dropped)) || typeof data.react !== "string" || !Array.isArray(data.samples) || data.samples.length > 1e3 || !Array.isArray(data.events) || data.events.length > MAX_RECORDED_EVENTS) throw new Error("Invalid Performance recording");
  for (const s of data.samples) {
    if (!object(s) || !finite(s.t) || typeof s.visible !== "boolean" || !["fps", "frameP95", "frameMax"].every((k) => s[k] === null || finite(s[k])) || !finite(s.commits) || !finite(s.renderMs) || !Array.isArray(s.processes) || s.processes.length > 1e3) throw new Error("Invalid sample");
    if (!(s.late === void 0 || typeof s.late === "boolean") || !(s.gap === void 0 || finite(s.gap))) throw new Error("Invalid sample");
    if (s.listeners !== void 0 && (!object(s.listeners) || Object.keys(s.listeners).length > 2e3 || !Object.values(s.listeners).every(finite))) throw new Error("Invalid subscription counts");
    for (const p of s.processes) if (!object(p) || !finite(p.pid) || !finite(p.memory) || !finite(p.cpuSeconds) || !(p.cpu === null || finite(p.cpu)) || typeof p.name !== "string" || typeof p.scope !== "string") throw new Error("Invalid process sample");
  }
  for (const e of data.events) if (!object(e) || !finite(e.t) || !["kind", "plugin", "name"].every((k) => typeof e[k] === "string") || !(e.duration === null || finite(e.duration)) || !(e.count === void 0 || finite(e.count)) || !(e.window === void 0 || typeof e.window === "string")) throw new Error("Invalid event");
  for (const e of data.events) {
    const d = e.detail;
    if (d !== void 0 && (!object(d) || !finite(d.id) || !(d.parent === null || finite(d.parent)) || !finite(d.depth) || d.depth < 0 || typeof d.reason !== "string" || !Array.isArray(d.props) || d.props.length > 100 || !d.props.every((p) => typeof p === "string" && p.length <= 100) || !(d.selfMs === null || finite(d.selfMs)) || typeof d.candidate !== "boolean")) throw new Error("Invalid React detail");
    const input = e.input;
    if (input !== void 0 && (!object(input) || typeof input.type !== "string" || !finite(input.delay) || !finite(input.processing))) throw new Error("Invalid input timing");
  }
  const plugins = new Set(data.events.map((e) => e.plugin));
  if (plugins.size > 512) throw new Error("Recording has too many plugin identities");
  if (data.metrics !== void 0) {
    if (!Array.isArray(data.metrics) || data.metrics.length > MAX_SERIES) throw new Error("Invalid metrics");
    const pairs = (v, width, max) => Array.isArray(v) && v.length <= max && v.every((r) => Array.isArray(r) && r.length === width && r.every(finite));
    for (const m of data.metrics) {
      if (!object(m) || typeof m.name !== "string" || m.name.length > 128 || !object(m.labels) || Object.keys(m.labels).length > 8 || !Object.values(m.labels).every((v) => typeof v === "string" && v.length <= 128) || !["count", "sum", "min", "max", "last", "t"].every((k) => finite(m[k])) || !pairs(m.recent, 2, METRIC_RING) || !pairs(m.seconds, 3, 121)) throw new Error("Invalid metric series");
    }
  }
  if (finite(data.dropped)) data.dropped = data.dropped ? { events: data.dropped } : {};
  data.events.sort((a, b) => a.t - b.t);
  return data;
}
function saved(value2) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("tilr-performance", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Recording database is blocked"));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("recordings", value2 ? "readwrite" : "readonly");
      const store = tx.objectStore("recordings");
      const operation = value2 ? store.put(value2, "last") : store.get("last");
      tx.oncomplete = () => {
        db.close();
        resolve(value2 ?? operation.result);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
class Performance extends Service {
  static provide = "performance";
  static inject = ["windows", "ui", "plugins"];
  static version = "0.1.14";
  static author = "dan";
  static tags = ["debug", "performance"];
  constructor(ctx) {
    super(ctx, "performance");
    this.state = { recordingStart: null, persist: true, recording: null, baseline: null, listeners: /* @__PURE__ */ new Set(), restored: false, disposed: false, warning: "" };
    ctx.ui.style(css);
    ctx.windows.register("performance", {
      title: "Performance",
      open: "never",
      mount: (host) => this.mount(host)
    });
    ctx.inject(["menu"], (scope) => {
      const menu = scope.get("menu");
      menu.contribute(() => [{ label: "Performance…", run: () => this.open() }]);
    });
    const collector = performanceCollector;
    const update = () => {
      if (this.state.recordingStart !== null && performance.now() - this.state.recordingStart >= 6e4) this.finish();
      this.changed();
    };
    if (collector) collector.listeners.add(update);
    ctx.effect(() => () => {
      collector?.listeners.delete(update);
      this.state.disposed = true;
      this.state.listeners.clear();
      if (performanceCollector) {
        if (this.state.persist) this.state.recording ??= performanceCollector.snapshot(this.state.recordingStart ?? void 0);
        stopPerformance();
        requestPerformance(false);
        void this.persist().finally(() => {
          setTimeout(() => location.reload(), 0);
        });
      }
    }, "performance lifetime");
  }
  analyze(plugin, highlight = false) {
    if (!performanceCollector) throw new Error("Enable collection first");
    performanceCollector.analyze(plugin, highlight);
    this.changed();
  }
  get enabled() {
    return !!performanceCollector;
  }
  /** A record() is in progress (until finish() or the 60 s auto-stop). */
  get recording() {
    return this.state.recordingStart !== null;
  }
  /** How far back the live history (samples, events, metric buckets) reaches, ms. */
  get history() {
    return HISTORY;
  }
  /** The process / FPS sampler's period, ms. */
  get sampleInterval() {
    return SAMPLE_INTERVAL;
  }
  open() {
    const layout = this.ctx.root.get("layout");
    const existing = layout?.list().find((window) => window.type === "performance");
    if (existing) layout?.focus(existing.id);
    else layout?.open({ type: "performance" });
  }
  async enable(on) {
    if (!on) {
      if (this.state.recordingStart !== null) this.finish();
      this.state.recording ??= this.snapshot();
    }
    requestPerformance(on);
    if (!on) {
      stopPerformance();
      this.changed();
      await this.persist();
    }
    location.reload();
  }
  metrics() {
    return performanceCollector?.metrics() ?? "# TYPE tilr_performance_enabled gauge\ntilr_performance_enabled 0\n";
  }
  snapshot() {
    return performanceCollector?.snapshot() ?? null;
  }
  /** The metric series of the live history (what snapshot().metrics is, without copying the
   *  samples and events); null while collection is off. */
  series() {
    return performanceCollector?.metricList(performance.now() - HISTORY) ?? null;
  }
  /** A light look at what memory growth could come from, for `tilr ctl debug memory`: counts
   *  only, no copies of the buffers. null while collection is off. */
  probe() {
    const c = performanceCollector;
    if (!c) return null;
    const byPlugin = c.listenerCounts();
    const registry = this.ctx.windows.state?.mounted;
    return {
      t: performance.now(),
      processes: c.latestProcesses().map((p) => ({ role: p.name, scope: p.scope, pid: p.pid, memory: p.memory, cpu: p.cpu })),
      windows: registry?.size ?? this.ctx.root.get("layout")?.list().length ?? 0,
      domNodes: document.getElementsByTagName("*").length,
      listeners: { total: Object.values(byPlugin).reduce((n, v) => n + v, 0), byPlugin },
      reactRoots: c.reactRoots(),
      canvases: document.querySelectorAll("canvas").length,
      images: document.getElementsByTagName("img").length
    };
  }
  /** The native memory breakdown per process (see api.d.ts); null without a bridge that knows it. */
  async footprint() {
    return footprintReply(await nativeRequest("footprint"));
  }
  /** Asks WebKit to release memory (possibly system-wide); null without a bridge that knows it. */
  async squeeze() {
    return squeezeReply(await nativeRequest("squeeze"));
  }
  /** Opens Safari Web Inspector for the page: whether it was shown. */
  async inspector() {
    const reply = await nativeRequest("inspector");
    return isObject(reply) && reply.shown === true;
  }
  /** `persist: false` (a tool's recording, the bench): finish() returns the recording but
   *  leaves the saved one (the window's, IndexedDB) as it was. */
  record({ persist = true } = {}) {
    if (!performanceCollector) throw new Error("Enable collection first");
    if (this.state.recordingStart === null) performanceCollector.demand("recording", true);
    this.state.recordingStart = performance.now();
    this.state.persist = persist;
    if (persist) this.state.recording = null;
    this.changed();
  }
  /** Stops the recording and returns it (cut to the recording's window), stored and saved
   *  unless record() was told `persist: false`; null when none was in progress. */
  finish() {
    if (this.state.recordingStart === null) return null;
    performanceCollector?.demand("recording", false);
    const recording = performanceCollector?.snapshot(this.state.recordingStart) ?? null;
    const persist = this.state.persist;
    this.state.recordingStart = null;
    this.state.persist = true;
    if (persist) this.state.recording = recording;
    this.changed();
    if (persist) void this.persist();
    return recording;
  }
  async persist() {
    try {
      await saved({ recording: this.state.recording, baseline: this.state.baseline });
    } catch {
      this.state.warning = "Could not save the recording locally. Use Save JSON before reloading.";
      this.changed();
    }
  }
  changed() {
    for (const fn of this.state.listeners) fn();
  }
  mount(host) {
    const collector = performanceCollector;
    let samplingFrames = false;
    const root = text("div", "", "perf");
    root.innerHTML = `<div class="toolbar">
      <button data-action="enable"></button><button data-action="record">Record · up to 60s</button>
      <button data-action="finish">Stop recording</button><button data-action="live">Live</button>
      <button data-action="review">Review recording</button><button data-action="save">Save JSON</button><button data-action="import">Open JSON</button><input type="file" accept=".json,application/json" aria-label="Open recording" hidden>
      <button data-action="baseline">Use as baseline</button><label><input type="checkbox" class="sample-fps"> Measure FPS</label>
    </div><div class="status muted"></div><div class="error" role="status"></div>
    <div class="toolbar"><label>Plugin <select aria-label="Plugin"><option value="">All plugins</option></select></label>
      <button data-action="analyze">Analyze selected plugin</button><button data-action="analysis-off">Stop analysis</button><label><input type="checkbox" class="highlight"> Highlight renders</label><span class="analysis-status muted"></span>
      <label class="review">Review sample <input type="range" min="0" value="0" aria-label="Review sample"></label></div>
    <div class="metrics"></div><div class="graphs"></div><div class="comparison muted"></div>
    <details class="memory"><summary>Memory · process footprint by category</summary>
      <div class="toolbar"><button data-action="mem-refresh">Refresh</button><button data-action="mem-squeeze">Squeeze</button><button data-action="mem-inspector">Inspector</button><span class="mem-status muted"></span></div>
      <div class="mem-squeeze-result muted"></div><table class="footprint"></table>
      <div class="muted">Read once when opened and on Refresh (100–300 ms of native work), never on a timer. Squeeze asks WebKit to release caches and garbage (it can reach other apps too: a low-memory signal); what it gives back was never a leak. Graphics is compositing layers and tiles: Inspector → Layers shows them.</div></details>
    <strong>Plugins · selected interval</strong><div class="scroll"><table class="plugins"></table></div>
    <strong>Chains · p50 / p95 ms over the last 10 s</strong><div class="muted">metric() observations with a <code>chain</code> label, one row per chain and subject (pane, else window, else plugin); hops in <code>NN-name</code> order. The bar stacks each hop's p95; total is their sum. End-to-end: the chain's metrics labelled <code>end: '1'</code>. Rate: observations/s of the first hop. n: how many observations the percentiles are of; <code>(tail)</code>: a series keeps its latest 256, which did not reach back over the whole 10 s.</div><div class="scroll"><table class="chains"></table></div>
    <strong>Metrics · last 10 s</strong><div class="toolbar"><input type="search" class="metric-filter" placeholder="Filter by name or label" aria-label="Filter metrics"></div><div class="scroll"><table class="series"></table></div>
    <strong>React component tree · committed renders · latest 200</strong><div class="muted">Enable analysis for one plugin. Same observed inputs are candidates for investigation, not proven wasted work. Values are never recorded; reasons are inferred. Indentation shows component ancestry; bailed-out parents may be absent.</div><div class="scroll"><table class="components"></table></div>
    <strong>Processes · 100% CPU = one core</strong><div class="scroll"><table class="processes"></table></div>
    <details><summary>Timeline · latest 200 events</summary><div class="scroll"><table class="events"></table></div></details>
    <div class="muted">FPS estimates rAF cadence, not presented frames; the rAF loop runs while Measure FPS is checked, a recording runs or the exporter scraped within 5 s (otherwise n/a). Measuring FPS adds CPU load even on an idle page. Red marks on the FPS chart are main-thread stalls: a native process sample arrived more than 1.5 s after the previous one, because the page's timer that requests it was blocked. Memory is process physical footprint, not per-plugin heap.
    Listener counts cover Cordis event subscriptions; handler time covers their synchronous work. React counts describe committed work; component counts use React 19 Fiber diagnostics. Plugins with their own renderer may be unattributed.
    Closing this window keeps collection running. Start/stop collection reloads the page. Updated native Debug commands use this same collector.</div>`;
    host.append(root);
    if (!this.state.restored) {
      this.state.restored = true;
      void saved().then((value2) => {
        if (this.state.disposed || !value2) return;
        if (value2.recording && !this.state.recording && this.state.recordingStart === null) this.state.recording = parseRecording(JSON.stringify(value2.recording));
        if (value2.baseline && !this.state.baseline) this.state.baseline = parseRecording(JSON.stringify(value2.baseline));
        this.changed();
      }).catch(() => {
        this.state.warning = "Saved recording unavailable";
        this.changed();
      });
    }
    const elements = /* @__PURE__ */ new Map();
    const q = (selector) => {
      let element = elements.get(selector);
      if (!element) {
        element = root.querySelector(selector);
        elements.set(selector, element);
      }
      return element;
    };
    const button = (name) => q(`[data-action="${name}"]`);
    const filter = q("select");
    const slider = q("input[type=range]");
    const metricFilter = q(".metric-filter");
    const error = q(".error");
    q(".sample-fps").onchange = (event) => {
      const checked = event.target.checked;
      if (checked !== samplingFrames) collector?.demand("window", checked);
      samplingFrames = checked;
      draw();
    };
    let imported = null;
    let reviewing = false;
    let index = -1;
    let disposed = false;
    const known = /* @__PURE__ */ new Set();
    const recorded = () => imported ?? (reviewing ? this.state.recording : null);
    const current = () => recorded() ?? this.snapshot();
    const view = (wantMetrics) => {
      const recording = recorded();
      if (recording) return { react: recording.react, started: recording.started, ended: recording.ended, samples: recording.samples, lists: [recording.events], metrics: recording.metrics ?? [], dropped: recording.dropped, live: false };
      const c = performanceCollector;
      if (!c) return null;
      const now = performance.now();
      return { react: reactMode, started: Math.max(c.started, now - 12e4), ended: now, samples: c.samples, lists: [c.events, c.handlers], metrics: wantMetrics ? c.metricList(now - METRIC_WINDOW) : [], dropped: c.dropped, live: true };
    };
    const action = (name, fn) => {
      button(name).onclick = () => {
        try {
          const result = fn();
          draw();
          if (result) void result.then(() => {
            if (!disposed) draw();
          }).catch((e) => {
            if (!disposed) error.textContent = String(e);
          });
        } catch (e) {
          error.textContent = String(e);
        }
      };
    };
    action("enable", () => this.enable(!this.enabled));
    action("analyze", () => {
      if (!filter.value) throw new Error("Select one plugin first");
      this.analyze(filter.value, q(".highlight").checked);
    });
    action("analysis-off", () => this.analyze(null));
    q(".highlight").onchange = () => {
      if (performanceCollector?.analysisPlugin) this.analyze(performanceCollector.analysisPlugin, q(".highlight").checked);
    };
    action("record", () => {
      imported = null;
      reviewing = false;
      this.record();
    });
    action("finish", () => {
      this.finish();
      reviewing = true;
      index = -1;
    });
    action("review", () => {
      imported = null;
      reviewing = true;
      index = -1;
    });
    action("live", () => {
      imported = null;
      reviewing = false;
      index = -1;
    });
    action("save", () => {
      const data = current();
      if (data) return save("tilr-performance.json", JSON.stringify(data));
    });
    action("import", async () => {
      const native = nativeFiles();
      if (!native) {
        q("input[type=file]").click();
        return;
      }
      const source = await native.postMessage({ op: "open", maxBytes: 2e7 });
      if (disposed || source === null) return;
      imported = parseRecording(source);
      reviewing = true;
      index = -1;
      error.textContent = "";
    });
    action("baseline", () => {
      this.state.baseline = current();
      return this.persist();
    });
    q("input[type=file]").onchange = (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (file.size > 2e7) {
        error.textContent = "Recording exceeds 20 MB";
        return;
      }
      void file.text().then((source) => {
        if (disposed) return;
        imported = parseRecording(source);
        reviewing = true;
        index = -1;
        error.textContent = "";
        draw();
      }).catch((e) => {
        if (!disposed) error.textContent = String(e);
      });
    };
    filter.onchange = () => draw();
    metricFilter.oninput = () => draw();
    slider.oninput = () => {
      index = Number(slider.value);
      draw();
    };
    const previousRows = /* @__PURE__ */ new Map();
    const table = (selector, headers, rows) => {
      const el = q(selector);
      let head = el.tHead;
      if (!head) {
        head = el.createTHead();
        const tr = head.insertRow();
        for (const h of headers) tr.append(text("th", h));
      }
      const body = el.tBodies[0] ?? el.createTBody();
      const previous = previousRows.get(selector);
      rows.forEach((row, index2) => {
        const before = previous?.[index2];
        if (before?.length === row.length && row.every((value2, column) => typeof value2 === "string" ? value2 === before[column] : before[column] instanceof Node && value2.isEqualNode(before[column]))) return;
        const tr = body.rows[index2] ?? body.insertRow();
        row.forEach((value2, column) => {
          const td = tr.cells[column] ?? tr.insertCell();
          if (typeof value2 === "string") {
            if (td.textContent !== value2) td.textContent = value2;
          } else {
            const previous2 = td.firstChild;
            if (!previous2?.isEqualNode(value2)) td.replaceChildren(value2);
          }
        });
        while (tr.cells.length > row.length) tr.deleteCell(-1);
      });
      while (body.rows.length > rows.length) body.deleteRow(-1);
      previousRows.set(selector, rows);
    };
    const cardValues = [];
    const graph = (title) => {
      const box = document.createElement("div");
      box.append(text("div", title, "muted"));
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 600 70");
      svg.setAttribute("class", "chart");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", title);
      const markers = document.createElementNS(svg.namespaceURI, "g");
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "2");
      svg.append(markers, path);
      box.append(svg);
      q(".graphs").append(box);
      return (values, marks = []) => {
        const max = Math.max(1, ...values.filter((n) => n != null));
        const x = (i) => i * 600 / Math.max(1, values.length - 1);
        marks.forEach((mark, i) => {
          let line = markers.children[i];
          if (!line) {
            line = document.createElementNS(svg.namespaceURI, "line");
            line.setAttribute("y1", "0");
            line.setAttribute("y2", "70");
            line.setAttribute("class", "stall");
            markers.append(line);
          }
          setAttribute(line, "x1", String(x(mark)));
          setAttribute(line, "x2", String(x(mark)));
        });
        while (markers.children.length > marks.length) markers.lastElementChild?.remove();
        let gap = true;
        const points = [];
        values.forEach((value2, i) => {
          if (value2 == null) {
            gap = true;
            return;
          }
          points.push(`${gap ? "M" : "L"}${x(i)},${68 - value2 / max * 65}`);
          gap = false;
        });
        setAttribute(path, "d", points.join(" "));
      };
    };
    const fpsGraph = graph("FPS · page · history · red: main-thread stall");
    const memoryGraph = graph("WebContent memory · MiB · history");
    const timelineDisclosure = q(".events").closest("details");
    if (timelineDisclosure) timelineDisclosure.ontoggle = () => {
      if (timelineDisclosure.open) draw();
    };
    const tableSelectors = [".plugins", ".chains", ".series", ".components", ".processes", ".events"];
    const visibleTables = new Set(tableSelectors);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      let revealed = false;
      for (const entry of entries) {
        const selector = tableSelectors.find((selector2) => q(selector2).parentElement === entry.target);
        if (!selector) continue;
        if (entry.isIntersecting) {
          revealed ||= !visibleTables.has(selector);
          visibleTables.add(selector);
        } else visibleTables.delete(selector);
      }
      if (revealed && !disposed) draw(false);
    }, { root });
    for (const selector of tableSelectors) {
      const container = q(selector).parentElement;
      if (container) observer?.observe(container);
    }
    const draw = (force = true) => {
      const needed = (selector) => force || visibleTables.has(selector);
      const data = view(needed(".chains") || needed(".series"));
      if (this.state.warning) error.textContent = this.state.warning;
      else if (globalThis.__tilrPerf) error.textContent = "An older Mac shell injected legacy Debug. Performance will not start alongside it. Turn legacy Debug off, then enable Performance; update the Mac shell for unified controls.";
      else if (data?.react === "prod") error.textContent = "React durations require a dev or profiling build; counts remain available.";
      setText(button("enable"), this.enabled ? "Disable collection · reload" : "Enable collection · reload");
      const disabled = (name, value2) => {
        const el = button(name);
        if (el.disabled !== value2) el.disabled = value2;
      };
      disabled("record", !this.enabled || this.state.recordingStart !== null);
      disabled("finish", this.state.recordingStart === null);
      disabled("review", !this.state.recording);
      disabled("save", !data);
      disabled("baseline", !data);
      const drops = Object.entries(data?.dropped ?? {}).filter(([, n]) => n > 0).map(([kind, n]) => `${kind} ${n}`).join(", ") || "none";
      const status = `${this.enabled ? "Collection on" : "Collection off · no sampler running"}${imported ? " · imported recording" : reviewing ? " · recorded session" : " · live"}${this.state.recordingStart !== null ? " · RECORDING (auto-stop at 60s)" : ""}${data ? ` · React ${data.react} · dropped${data.live ? " (session)" : " (in recording)"}: ${drops}` : ""}${data?.live ? ` · frame loop ${performanceCollector?.framesOn ? "on" : "off"}` : ""}`;
      const reviewControl = q(".review");
      const hideReview = !reviewing || !data?.samples.length;
      if (reviewControl.hidden !== hideReview) reviewControl.hidden = hideReview;
      disabled("analyze", !this.enabled || !filter.value);
      disabled("analysis-off", !performanceCollector?.analysisPlugin);
      setText(q(".analysis-status"), performanceCollector?.analysisPlugin ? `Analyzing: ${performanceCollector.analysisPlugin}` : "Detailed analysis off");
      if (!data) {
        setText(q(".status"), status);
        return;
      }
      setAttribute(slider, "max", String(Math.max(0, data.samples.length - 1)));
      slider.value = String(index < 0 ? data.samples.length - 1 : Math.min(index, data.samples.length - 1));
      const sample = reviewing && index >= 0 ? data.samples[index] : data.samples.at(-1);
      const end = reviewing && index >= 0 ? sample?.t ?? data.ended : data.ended;
      const start = Math.max(data.started, end - (reviewing ? 6e4 : 1e3));
      setText(q(".status"), `${status} · interval +${number((start - data.started) / 1e3)}…${number((end - data.started) / 1e3)}s`);
      const only = filter.value;
      const plugins = /* @__PURE__ */ new Map();
      const timeline = [], details = [];
      const minute = end - 6e4;
      for (const list of data.lists) {
        const last = lowerBound(list, end + 1e-9);
        for (let i = lowerBound(list, minute); i < last; i++) {
          const e = list[i];
          if (e.t <= minute || only && e.plugin !== only) continue;
          let a = plugins.get(e.plugin);
          if (!a) {
            a = aggregate();
            plugins.set(e.plugin, a);
          }
          if (e.kind === "react") a.minuteCommits++;
          else if (e.kind === "component") a.minuteRenders += e.count ?? 0;
          if (e.t < start) continue;
          if (e.kind === "react") {
            a.commits++;
            a.renderMs += e.duration ?? 0;
            if (e.duration !== null) a.durations.push(e.duration);
          } else if (e.kind === "component") a.renders += e.count ?? 0;
          else if (e.kind === "load") a.loads++;
          else if (e.kind === "reload") a.reloads++;
          else if (e.kind === "error") a.errors++;
          else if (e.kind === "handler") a.handlerMs += e.duration ?? 0;
        }
        for (let i = last - 1, n = 0; i >= 0 && list[i].t >= start && n < 200; i--) if (!only || list[i].plugin === only) {
          timeline.push(list[i]);
          n++;
        }
        for (let i = last - 1; i >= 0 && details.length < 200; i--) {
          const e = list[i];
          if (e.kind === "render-detail" && e.detail && (!only || e.plugin === only)) details.push(e);
        }
      }
      let added = false;
      const names = [...plugins.keys(), ...this.ctx.plugins.list().map((p) => p.name), ...data.live ? performanceCollector?.totals.keys() ?? [] : []];
      for (const name of names) if (!known.has(name)) {
        known.add(name);
        added = true;
      }
      if (added) {
        const selected = filter.value;
        filter.replaceChildren(new Option("All plugins", ""), ...[...known].sort().map((p) => new Option(p, p)));
        filter.value = selected;
      }
      const seconds = Math.max(1e-3, (end - start) / 1e3);
      const all = [...plugins.values()];
      const sum = (key) => all.reduce((n, a) => n + a[key], 0);
      const stalls = data.samples.filter((s) => s.late && s.t <= end);
      const cards = [["FPS · page", sample?.fps == null ? "n/a" : number(sample.fps)], ["Frame p95 · ms", number(sample?.frameP95)], ["Frame max · ms", number(sample?.frameMax)], ["React commits/s", number(sum("commits") / seconds)], ["React component renders/s", number(sum("renders") / seconds)], ["React render ms/s", data.react === "prod" ? "—" : number(sum("renderMs") / seconds)], ["CPU · WebContent", number(cpu(sample)) + "%"], ["Memory · WebContent", sample?.processes.some((p) => p.name === "WebContent") ? number((memory(sample) ?? 0) / 1048576) + " MiB" : "—"], ["Main-thread stalls", stalls.length ? `${stalls.length} · last ${number((stalls.at(-1)?.gap ?? 0) / 1e3)}s` : "0"]];
      cards.forEach(([title, value2], i) => {
        if (!cardValues[i]) {
          const el = text("div", "", "metric");
          const valueElement = text("div", "", "value");
          el.append(text("div", title, "muted"), valueElement);
          q(".metrics").append(el);
          cardValues.push(valueElement);
        }
        setText(cardValues[i], value2);
      });
      const marks = data.samples.flatMap((s, i) => s.late ? [i] : []);
      fpsGraph(data.samples.map((s) => s.fps), marks);
      memoryGraph(data.samples.map((s) => s.processes.some((p) => p.name === "WebContent") ? (memory(s) ?? 0) / 1048576 : null));
      if (needed(".plugins")) {
        const rows = [.../* @__PURE__ */ new Set([...plugins.keys(), ...Object.keys(sample?.listeners ?? {})])].filter((name) => !only || only === name).map((name) => {
          const a = plugins.get(name) ?? aggregate();
          return { cost: Math.max(a.renderMs, a.handlerMs), row: [name, number(a.commits / seconds), String(a.minuteCommits), number(a.renders / seconds), String(a.minuteRenders), data.react === "prod" ? "—" : number(a.renderMs), String(a.renders), String(a.loads), String(a.reloads), String(a.errors), number(a.handlerMs), String(sample?.listeners?.[name] ?? 0), number(percentile(a.durations, 0.95)), number(percentile(a.durations, 1))] };
        }).sort((a, b) => b.cost - a.cost);
        table(".plugins", ["Plugin", "Commits/s", "Commits/60s*", "Renders/s", "Renders/60s*", "Render ms", "Component renders", "Loads", "Reloads", "Errors", "Handler ms", "Listeners", "Render p95 ms", "Render max ms"], rows.map((r) => r.row));
      }
      if (needed(".chains")) drawChains(table, data.metrics, end);
      if (needed(".series")) {
        const needle = metricFilter.value.trim().toLowerCase();
        const series = data.metrics.map((m) => ({ m, labels: Object.entries(m.labels).map(([k, v]) => `${k}=${v}`).join(" ") })).filter(({ m, labels }) => !needle || `${m.name} ${labels}`.toLowerCase().includes(needle)).sort((a, b) => a.m.name.localeCompare(b.m.name) || a.labels.localeCompare(b.labels));
        table(".series", ["Metric", "Labels", "Count", "Rate/s", "p50", "p95", "Max", "n", "Last"], series.map(({ m, labels }) => {
          const s = metricStats(m, end, METRIC_WINDOW);
          return [m.name, labels, String(m.count), number(s.rate), value(s.p50), value(s.p95), value(s.max), observations(s), value(m.last)];
        }));
      }
      if (needed(".components")) {
        details.sort((a, b) => a.t - b.t);
        table(".components", ["Time s", "Plugin / window", "Component / instance", "Parent", "Reason (inferred)", "Changed props", "Self ms", "Subtree ms", "Candidate"], details.map((e) => {
          const d = e.detail;
          if (!d) return [];
          return [number((e.t - data.started) / 1e3, 3), `${e.plugin}${e.window ? " / " + e.window : ""}`, `${"· ".repeat(Math.min(d.depth, 20))}${e.name} #${d.id}`, d.parent === null ? "—" : String(d.parent), d.reason, d.props.join(", "), number(d.selfMs), number(e.duration), d.candidate ? "Same observed inputs; inspect" : "—"];
        }));
      }
      if (needed(".processes")) {
        const history = /* @__PURE__ */ new Map();
        for (const s of data.samples) {
          if (s.t > end) break;
          for (const p of s.processes) {
            const h = history.get(p.pid);
            if (h) h.peak = Math.max(h.peak, p.memory);
            else history.set(p.pid, { first: p.memory, peak: p.memory });
          }
        }
        table(".processes", ["Process / scope", "PID", "CPU %", "Memory MiB", "Peak MiB", "Δ MiB"], (sample?.processes ?? []).map((p) => {
          const h = history.get(p.pid) ?? { first: p.memory, peak: p.memory };
          return [`${p.name} / ${p.scope}`, String(p.pid), number(p.cpu), number(p.memory / 1048576), number(Math.max(h.peak, p.memory) / 1048576), number((p.memory - h.first) / 1048576)];
        }));
      }
      if (timelineDisclosure?.open && needed(".events")) {
        timeline.sort((a, b) => b.t - a.t);
        table(".events", ["Time s", "Plugin", "Event", "ms / count"], timeline.slice(0, 200).map((e) => [number((e.t - data.started) / 1e3, 3), e.plugin, `${e.kind}: ${e.name}`, e.count === void 0 ? number(e.duration) : String(e.count)]));
      }
      const base = this.state.baseline;
      const baselineSample = base?.samples.at(-1);
      setText(q(".comparison"), `* Actual count in the available last 60s (may be shorter). ${base ? `Baseline: FPS Δ ${sample?.fps != null && baselineSample?.fps != null ? number(sample.fps - baselineSample.fps) : "—"}; WebContent memory Δ ${memory(sample) && memory(baselineSample) ? number(((memory(sample) ?? 0) - (memory(baselineSample) ?? 0)) / 1048576) + " MiB" : "—"}.` : "Use as baseline to compare a later measurement."}`);
    };
    const card = q("details.memory");
    const memoryStatus = q(".mem-status");
    const bridged = !!nativeFiles();
    const mib = (n) => number(n / 1048576);
    let read = false;
    const footprint = async () => {
      read = true;
      memoryStatus.textContent = "Reading…";
      const reply = await this.footprint();
      if (disposed) return;
      if (!reply) {
        memoryStatus.textContent = "n/a (update the Mac app)";
        q(".footprint").replaceChildren();
        previousRows.delete(".footprint");
        return;
      }
      memoryStatus.textContent = reply.error ? `error: ${reply.error}` : `took ${number(reply.took, 0)} ms`;
      table(".footprint", ["Process / scope", "PID", "Footprint MiB", "malloc", "graphics", "js", "jit", "other", "Reclaimable"], reply.processes.map((p) => [`${p.role} / ${p.scope}`, String(p.pid), mib(p.footprint), mib(p.categories.malloc), mib(p.categories.graphics), mib(p.categories.js), mib(p.categories.jit), mib(p.categories.other), mib(p.reclaimable)]));
    };
    const run = (fn) => () => {
      void fn().catch((e) => {
        if (!disposed) memoryStatus.textContent = String(e);
      });
    };
    if (!bridged) {
      memoryStatus.textContent = "n/a: no native bridge (the Mac app only)";
      for (const name of ["mem-refresh", "mem-squeeze", "mem-inspector"]) button(name).disabled = true;
    }
    card.ontoggle = () => {
      if (card.open && !read && bridged) run(footprint)();
    };
    button("mem-refresh").onclick = run(footprint);
    button("mem-squeeze").onclick = run(async () => {
      const out = q(".mem-squeeze-result");
      out.textContent = "Squeezing…";
      const reply = await this.squeeze();
      if (disposed) return;
      out.textContent = reply ? `Squeeze (${reply.method || "native"}): WebContent ${mib(reply.before)} → ${mib(reply.after)} MiB (${mib(reply.after - reply.before)})` : "Squeeze: n/a (update the Mac app)";
    });
    button("mem-inspector").onclick = run(async () => {
      const shown = await this.inspector();
      if (!disposed) memoryStatus.textContent = shown ? "Web Inspector opened" : "Inspector: n/a (update the Mac app)";
    });
    const refresh = () => {
      if (document.visibilityState === "visible") draw(false);
    };
    document.addEventListener("visibilitychange", refresh);
    this.state.listeners.add(refresh);
    draw();
    return () => {
      disposed = true;
      observer?.disconnect();
      document.removeEventListener("visibilitychange", refresh);
      if (samplingFrames) collector?.demand("window", false);
      this.state.listeners.delete(refresh);
      root.remove();
    };
  }
}
const aggregate = () => ({ commits: 0, renders: 0, renderMs: 0, durations: [], handlerMs: 0, loads: 0, reloads: 0, errors: 0, minuteCommits: 0, minuteRenders: 0 });
const value = (n) => n == null ? "—" : Math.abs(n) >= 1e3 ? n.toFixed(0) : n.toFixed(2);
const hopColor = (i) => `hsl(${(205 + i * 67) % 360} 60% 52%)`;
const observations = (s) => `${s.n}${s.coverage === "tail" ? " (tail)" : ""}`;
const swatch = (color) => {
  const el = document.createElement("i");
  el.className = "swatch";
  el.style.background = color;
  return el;
};
const byHop = (a, b) => a.localeCompare(b, void 0, { numeric: true });
function drawChains(table, metrics, end) {
  const groups = /* @__PURE__ */ new Map();
  for (const m of metrics) {
    const { chain, hop, pane, window, plugin } = m.labels;
    if (!chain || !hop && m.labels.end !== "1") continue;
    const subject = pane ? `pane ${pane}` : window ? `window ${window}` : plugin ? `plugin ${plugin}` : "—";
    const key = `${chain}\0${subject}`;
    let group = groups.get(key);
    if (!group) {
      group = { chain, subject, hops: /* @__PURE__ */ new Map(), ends: /* @__PURE__ */ new Map() };
      groups.set(key, group);
    }
    const stats = metricStats(m, end, METRIC_WINDOW);
    if (hop) {
      const h = group.hops.get(hop) ?? { values: [], rate: 0, tail: false };
      h.values.push(...stats.values);
      h.rate += stats.rate;
      h.tail ||= stats.coverage === "tail";
      group.hops.set(hop, h);
    } else group.ends.set(m.name, [...group.ends.get(m.name) ?? [], ...stats.values]);
  }
  const rows = [...groups.values()].sort((a, b) => a.chain.localeCompare(b.chain) || a.subject.localeCompare(b.subject)).map((group) => {
    const hops = [...group.hops].sort(([a], [b]) => byHop(a, b)).map(([name, h]) => ({ name, rate: h.rate, p50: percentile(h.values, 0.5), p95: percentile(h.values, 0.95), n: h.values.length, coverage: h.tail ? "tail" : "full" }));
    return { group, hops, total: hops.reduce((n, h) => n + (h.p95 ?? 0), 0) };
  });
  const scale = Math.max(1e-3, ...rows.map((r) => r.total));
  const names = [...new Set(rows.flatMap((r) => r.hops.map((h) => h.name)))].sort(byHop);
  const color = (name) => hopColor(names.indexOf(name));
  table(".chains", ["Chain", "Subject", "Rate/s", "Hops · p50 / p95 ms", "p95 by hop", "Total p95 ms", "End-to-end p50 / p95 ms"], rows.map(({ group, hops, total }) => {
    const legend = document.createElement("div");
    legend.className = "hops";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `p95 by hop, total ${value(total)} ms`);
    for (const h of hops) {
      const item = document.createElement("span");
      item.append(swatch(color(h.name)), `${h.name} ${value(h.p50)} / ${value(h.p95)} · n=${observations(h)}`);
      legend.append(item);
      const part = document.createElement("span");
      part.style.width = `${(h.p95 ?? 0) / scale * 100}%`;
      part.style.background = color(h.name);
      part.title = `${h.name}: p95 ${value(h.p95)} ms`;
      bar.append(part);
    }
    const ends = [...group.ends].map(([name, values]) => `${name} ${value(percentile(values, 0.5))} / ${value(percentile(values, 0.95))}`).join("; ") || "—";
    return [group.chain, group.subject, number(hops[0]?.rate), legend, bar, value(total), ends];
  }));
}
var performance_default = Performance;
export {
  performance_default as default,
  footprintReply,
  parseRecording,
  squeezeReply
};
//# sourceMappingURL=index.js.map
