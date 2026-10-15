import { Service } from "cordis";
import { nativeChannel } from "tilr/native";
const HANDLER = "tilrAudio";
const EVENT = "tilr-audio";
const BANDS = [60, 170, 310, 600, 1e3, 3e3, 6e3, 12e3, 14e3, 16e3];
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const known = (seconds) => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
function initial() {
  return { status: "stopped", url: null, position: 0, duration: 0, stalled: false, volume: 1, balance: 0, eq: { enabled: false, preamp: 0, bands: BANDS.map(() => 0) } };
}
function mergeEq(eq, patch) {
  const bands = patch.bands ?? eq.bands;
  return {
    enabled: patch.enabled ?? eq.enabled,
    preamp: clamp(patch.preamp ?? eq.preamp, -12, 12),
    bands: BANDS.map((_, i) => clamp(bands[i] ?? 0, -12, 12))
  };
}
const sameEq = (a, b) => a.enabled === b.enabled && a.preamp === b.preamp && a.bands.every((v, i) => v === b.bands[i]);
class Core {
  key;
  /** False once disposed, or once the service that made it has gone: it does nothing then. */
  live = true;
  listeners = /* @__PURE__ */ new Set();
  events = /* @__PURE__ */ new Map();
  constructor(key) {
    this.key = key;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  on(event, listener) {
    let set = this.events.get(event);
    if (!set) this.events.set(event, set = /* @__PURE__ */ new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
  notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
    }
  }
  emit(event, detail) {
    for (const listener of [...this.events.get(event) ?? []]) {
      try {
        listener(detail);
      } catch (error) {
        console.error(error);
      }
    }
  }
  /** The service went: the player lives on (the next service adopts it), this object does not. */
  release() {
    this.live = false;
    this.listeners.clear();
    this.events.clear();
  }
  dispose() {
    if (!this.live) return;
    this.close();
    this.release();
  }
}
class Handle {
  core;
  ctx;
  constructor(core, ctx) {
    this.core = core;
    this.ctx = ctx;
  }
  get key() {
    return this.core.key;
  }
  get status() {
    return this.core.state.status;
  }
  get url() {
    return this.core.state.url;
  }
  get position() {
    return this.core.state.position;
  }
  get duration() {
    return this.core.state.duration;
  }
  get stalled() {
    return this.core.state.stalled;
  }
  get volume() {
    return this.core.state.volume;
  }
  get balance() {
    return this.core.state.balance;
  }
  get eq() {
    return this.core.state.eq;
  }
  load(url, meta) {
    if (this.core.live) this.core.load(url, meta);
  }
  play() {
    if (this.core.live) this.core.play();
  }
  pause() {
    if (this.core.live) this.core.pause();
  }
  stop() {
    if (this.core.live) this.core.stop();
  }
  seek(seconds) {
    if (this.core.live) this.core.seek(seconds);
  }
  setVolume(volume) {
    if (this.core.live) this.core.setVolume(volume);
  }
  setBalance(balance) {
    if (this.core.live) this.core.setBalance(balance);
  }
  setEq(eq) {
    if (this.core.live) this.core.setEq(eq);
  }
  analyser() {
    return this.core.live ? this.core.analyser() : null;
  }
  subscribe(listener) {
    return this.owned(this.core.subscribe(listener), "audio: subscribe()");
  }
  on(event, callback) {
    return this.owned(this.core.on(event, callback), `audio: on('${event}')`);
  }
  dispose() {
    this.core.dispose();
  }
  /** `off` as an effect of the caller, so the listener leaves with it; the returned function
   *  removes it earlier (and the effect with it). A caller that is not running keeps it as is. */
  owned(off, label) {
    if (!this.ctx) return off;
    try {
      const dispose = this.ctx.effect(() => off, label);
      return () => {
        void dispose();
      };
    } catch {
      return off;
    }
  }
}
class NativePlayer extends Core {
  post;
  now;
  onClose;
  base = initial();
  /** When `base.position` was true, and how fast it moves since (0 or 1). */
  at = 0;
  rate = 0;
  constructor(key, post, now, onClose) {
    super(key);
    this.post = post;
    this.now = now;
    this.onClose = onClose;
  }
  get state() {
    return { ...this.base, position: this.position() };
  }
  position() {
    const { status, position, duration } = this.base;
    if (status !== "playing" || !this.rate) return position;
    const moved = position + (this.now() - this.at) / 1e3 * this.rate;
    return duration > 0 ? Math.min(moved, duration) : moved;
  }
  /** Merges `patch` (and the position's base) into the state; tells the listeners if anything
   *  but the position moving on changed. */
  apply(patch, motion) {
    const next = { ...this.base, ...patch };
    let changed = false;
    for (const key of ["status", "url", "duration", "stalled", "volume", "balance"]) {
      if (next[key] !== this.base[key]) changed = true;
    }
    if (!sameEq(next.eq, this.base.eq)) changed = true;
    if (motion) {
      if (Math.abs(this.position() - motion.position - (this.now() - motion.at) / 1e3 * motion.rate) > 0.05 || motion.rate !== this.rate) changed = true;
      next.position = motion.position;
      this.at = motion.at;
      this.rate = motion.rate;
    }
    this.base = next;
    if (changed) this.notify();
  }
  /** The app's report. */
  report(report) {
    this.apply({
      status: report.status,
      url: report.url ?? null,
      duration: known(report.duration),
      stalled: !!report.stalled,
      volume: clamp(report.volume, 0, 1)
    }, { position: Number(report.position) || 0, at: Number(report.at) || this.now(), rate: report.status === "playing" ? Number(report.rate) || 0 : 0 });
  }
  load(url, meta) {
    this.apply({ status: "stopped", url, duration: 0, stalled: false }, { position: 0, at: this.now(), rate: 0 });
    this.post({ op: "load", id: this.key, url, ...meta?.title !== void 0 && { title: meta.title }, ...meta?.artist !== void 0 && { artist: meta.artist } });
  }
  play() {
    if (this.base.url === null) return;
    if (this.base.status !== "playing") this.apply({ status: "playing" }, { position: this.position(), at: this.now(), rate: 1 });
    this.post({ op: "play", id: this.key });
  }
  pause() {
    if (this.base.status === "playing") this.apply({ status: "paused" }, { position: this.position(), at: this.now(), rate: 0 });
    this.post({ op: "pause", id: this.key });
  }
  stop() {
    this.apply({ status: "stopped" }, { position: 0, at: this.now(), rate: 0 });
    this.post({ op: "stop", id: this.key });
  }
  seek(seconds) {
    const { duration } = this.base;
    const position = clamp(seconds, 0, duration > 0 ? duration : Infinity);
    this.apply({}, { position, at: this.now(), rate: this.base.status === "playing" ? 1 : 0 });
    this.post({ op: "seek", id: this.key, position });
  }
  setVolume(volume) {
    const v = clamp(volume, 0, 1);
    this.apply({ volume: v });
    this.post({ op: "volume", id: this.key, volume: v });
  }
  setBalance(balance) {
    const b = clamp(balance, -1, 1);
    this.apply({ balance: b });
    this.post({ op: "balance", id: this.key, balance: b });
  }
  setEq(patch) {
    const eq = mergeEq(this.base.eq, patch);
    this.apply({ eq });
    this.post({ op: "eq", id: this.key, ...eq });
  }
  analyser() {
    return null;
  }
  /** The end of the track, told by the app: stopped at 0 (the state that follows says so too). */
  ended() {
    this.apply({ status: "stopped" }, { position: 0, at: this.now(), rate: 0 });
    this.emit("ended");
  }
  close() {
    this.post({ op: "dispose", id: this.key });
    this.onClose(this);
  }
}
class NativeAudio {
  players = /* @__PURE__ */ new Map();
  post;
  now;
  constructor(post, now = Date.now) {
    this.post = post;
    this.now = now;
  }
  /** Asks the app for the players it has. */
  start() {
    this.post({ op: "list" });
  }
  /** The player `key`: the known one, else a new one the app is asked to create (or to report,
   *  if it has it already). */
  player(key) {
    const existing = this.players.get(key);
    if (existing) return existing;
    const player = this.adopt(key);
    this.post({ op: "create", id: key });
    return player;
  }
  adopt(key) {
    const player = new NativePlayer(key, this.post, this.now, (closed) => {
      if (this.players.get(closed.key) === closed) this.players.delete(closed.key);
    });
    this.players.set(key, player);
    return player;
  }
  receive(detail) {
    if (!detail || typeof detail !== "object") return;
    switch (detail.type) {
      case "list":
        for (const report of detail.players ?? []) (this.players.get(report.id) ?? this.adopt(report.id)).report(report);
        return;
      case "state":
        return (this.players.get(detail.id) ?? this.adopt(detail.id)).report(detail);
      case "ended":
        return this.players.get(detail.id)?.ended();
      case "error":
        return this.players.get(detail.id)?.emit("error", { message: detail.message });
      case "command":
        return this.players.get(detail.id)?.emit("command", { command: detail.command });
    }
  }
  /** The service going: the app keeps the players, this page forgets them. */
  release() {
    for (const player of this.players.values()) player.release();
    this.players.clear();
  }
}
function holder() {
  return globalThis.__tilrAudio ??= { context: null, graphs: /* @__PURE__ */ new Map() };
}
function context() {
  const h = holder();
  if (!h.context || h.context.state === "closed") h.context = new AudioContext();
  return h.context;
}
const factor = (db) => 10 ** (db / 20);
function build(key) {
  const ctx = context();
  const audio = document.createElement("audio");
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  audio.dataset.tilrAudio = key;
  const source = ctx.createMediaElementSource(audio);
  const input = ctx.createGain();
  const preamp = ctx.createGain();
  const filters = BANDS.map((frequency, i) => {
    const filter = ctx.createBiquadFilter();
    filter.type = i === 0 ? "lowshelf" : i === BANDS.length - 1 ? "highshelf" : "peaking";
    filter.frequency.value = frequency;
    filter.gain.value = 0;
    return filter;
  });
  const balanceIn = ctx.createGain();
  balanceIn.channelCount = 2;
  balanceIn.channelCountMode = "explicit";
  balanceIn.channelInterpretation = "speakers";
  const splitter = ctx.createChannelSplitter(2);
  const left = ctx.createGain();
  const right = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const gain = ctx.createGain();
  const analyserNode = ctx.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserNode.smoothingTimeConstant = 0;
  source.connect(input);
  let out = preamp;
  for (const filter of filters) {
    out.connect(filter);
    out = filter;
  }
  out.connect(balanceIn);
  balanceIn.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  merger.connect(gain);
  merger.connect(analyserNode);
  gain.connect(ctx.destination);
  const state = initial();
  const graph = { audio, source, input, preamp, filters, balanceIn, left, right, merger, gain, analyserNode, ...state, detach: null };
  route(graph);
  return graph;
}
function route(graph) {
  graph.input.disconnect();
  graph.input.connect(graph.eq.enabled ? graph.preamp : graph.balanceIn);
  graph.preamp.gain.value = factor(graph.eq.preamp);
  graph.filters.forEach((filter, i) => {
    filter.gain.value = graph.eq.bands[i] ?? 0;
  });
}
function describe(error) {
  if (!error) return "unknown error";
  const name = ["", "aborted", "network error", "cannot decode", "unsupported source"][error.code] ?? `error ${error.code}`;
  return error.message ? `${name}: ${error.message}` : name;
}
class WebPlayer extends Core {
  graph;
  onClose;
  constructor(key, graph, onClose) {
    super(key);
    this.graph = graph;
    this.onClose = onClose;
    this.attach();
  }
  get state() {
    const { status, url, duration, stalled, volume, balance, eq } = this.graph;
    return { status, url, position: this.graph.audio.currentTime || 0, duration, stalled, volume, balance, eq };
  }
  /** This module's listeners on the element, in place of the previous one's. They keep the
   *  graph's state right after this service has gone (until the next one adopts the graph). */
  attach() {
    const g = this.graph;
    g.detach?.();
    const set = (patch) => {
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (g[key] !== value) {
          Object.assign(g, { [key]: value });
          changed = true;
        }
      }
      if (changed && this.live) this.notify();
    };
    const handlers = {
      durationchange: () => set({ duration: known(g.audio.duration) }),
      loadedmetadata: () => set({ duration: known(g.audio.duration) }),
      waiting: () => set({ stalled: true }),
      playing: () => set({ stalled: false }),
      canplay: () => set({ stalled: false }),
      ended: () => {
        try {
          g.audio.currentTime = 0;
        } catch {
        }
        set({ status: "stopped", stalled: false });
        if (this.live) this.emit("ended");
      },
      error: () => {
        if (!g.audio.getAttribute("src")) return;
        g.audio.pause();
        set({ status: "stopped", stalled: false });
        if (this.live) this.emit("error", { message: describe(g.audio.error) });
      }
    };
    for (const [name, handler] of Object.entries(handlers)) g.audio.addEventListener(name, handler);
    g.detach = () => {
      for (const [name, handler] of Object.entries(handlers)) g.audio.removeEventListener(name, handler);
    };
  }
  change(patch) {
    Object.assign(this.graph, patch);
    this.notify();
  }
  load(url) {
    const { audio } = this.graph;
    audio.pause();
    audio.src = url;
    audio.load();
    this.change({ status: "stopped", url, duration: 0, stalled: false });
  }
  play() {
    const g = this.graph;
    if (g.url === null) return;
    const ctx = holder().context;
    if (ctx?.state === "suspended") void ctx.resume().catch(() => {
    });
    if (g.status !== "playing") this.change({ status: "playing" });
    g.audio.play().catch((error) => {
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError" || g.status !== "playing" || !g.audio.paused) return;
      Object.assign(g, { status: "paused" });
      if (!this.live) return;
      this.notify();
      this.emit("error", { message: error instanceof Error ? error.message : String(error) });
    });
  }
  pause() {
    const g = this.graph;
    if (g.status !== "playing") return;
    g.audio.pause();
    this.change({ status: "paused" });
  }
  stop() {
    const g = this.graph;
    g.audio.pause();
    try {
      g.audio.currentTime = 0;
    } catch {
    }
    this.change({ status: "stopped" });
  }
  seek(seconds) {
    const g = this.graph;
    try {
      g.audio.currentTime = clamp(seconds, 0, g.duration > 0 ? g.duration : Infinity);
    } catch {
    }
    this.notify();
  }
  setVolume(volume) {
    const v = clamp(volume, 0, 1);
    this.graph.gain.gain.value = v;
    if (v !== this.graph.volume) this.change({ volume: v });
  }
  setBalance(balance) {
    const b = clamp(balance, -1, 1);
    this.graph.left.gain.value = b > 0 ? 1 - b : 1;
    this.graph.right.gain.value = b < 0 ? 1 + b : 1;
    if (b !== this.graph.balance) this.change({ balance: b });
  }
  setEq(patch) {
    const eq = mergeEq(this.graph.eq, patch);
    if (sameEq(eq, this.graph.eq)) return;
    this.graph.eq = eq;
    route(this.graph);
    this.notify();
  }
  analyser() {
    return this.graph.analyserNode;
  }
  close() {
    const g = this.graph;
    g.detach?.();
    g.detach = null;
    g.audio.pause();
    g.audio.removeAttribute("src");
    g.audio.load();
    for (const node of [g.source, g.input, g.preamp, ...g.filters, g.balanceIn, g.left, g.right, g.merger, g.gain, g.analyserNode]) node.disconnect();
    const graphs = holder().graphs;
    if (graphs.get(this.key) === g) graphs.delete(this.key);
    this.onClose(this);
  }
}
const NATIVE_FEATURES = { eq: false, balance: false, analyser: false };
const WEB_FEATURES = { eq: true, balance: true, analyser: true };
class AudioService extends Service {
  static provide = "audio";
  static author = "dan";
  static tags = ["media"];
  static version = "0.1.14";
  constructor(ctx) {
    super(ctx, AudioService.provide);
    const channel = nativeChannel(HANDLER, EVENT);
    const native = channel ? new NativeAudio((body) => channel.post(body)) : null;
    this.state = { native, web: /* @__PURE__ */ new Map() };
    if (channel && native) {
      ctx.effect(() => {
        const off = channel.listen((event) => native.receive(event));
        native.start();
        return () => {
          off();
          native.release();
        };
      }, "audio: native events");
      return;
    }
    for (const [key, graph] of holder().graphs) this.state.web.set(key, this.webPlayer(key, graph));
    const resume = () => {
      const audio = holder().context;
      if (audio?.state === "suspended") void audio.resume().catch(() => {
      });
    };
    ctx.effect(() => {
      document.addEventListener("pointerdown", resume, true);
      document.addEventListener("keydown", resume, true);
      return () => {
        document.removeEventListener("pointerdown", resume, true);
        document.removeEventListener("keydown", resume, true);
      };
    }, "audio: resume on a gesture");
    ctx.effect(() => () => {
      for (const player of this.state.web.values()) player.release();
      this.state.web.clear();
    }, "audio: players");
  }
  get backend() {
    return this.state.native ? "native" : "web";
  }
  get features() {
    return { ...this.state.native ? NATIVE_FEATURES : WEB_FEATURES };
  }
  player(key) {
    return new Handle(this.core(String(key)), this.ctx);
  }
  players() {
    const { native, web } = this.state;
    const cores = native ? [...native.players.values()] : [...web.values()];
    return cores.map((core) => new Handle(core, this.ctx));
  }
  core(key) {
    const { native, web } = this.state;
    if (native) return native.player(key);
    let player = web.get(key);
    if (!player) {
      const graphs = holder().graphs;
      let graph = graphs.get(key);
      if (!graph) graphs.set(key, graph = build(key));
      player = this.webPlayer(key, graph);
      web.set(key, player);
    }
    return player;
  }
  webPlayer(key, graph) {
    return new WebPlayer(key, graph, (closed) => {
      if (this.state.web.get(closed.key) === closed) this.state.web.delete(closed.key);
    });
  }
}
var audio_default = AudioService;
export {
  BANDS,
  EVENT,
  HANDLER,
  NativeAudio,
  NativePlayer,
  audio_default as default,
  initial,
  mergeEq
};
//# sourceMappingURL=index.js.map
