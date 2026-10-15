import { Service } from "cordis";
import { nativeChannel } from "tilr/native";
const HANDLER = "tilrWebViews";
const EVENT = "tilr-webview";
const LAYERS = ".tilr-canvas > .window, .tilr-canvas > .drop";
function placement(host, overlays = []) {
  const rect = host.getBoundingClientRect();
  const shown = host.isConnected && rect.width > 0 && rect.height > 0 && (host.checkVisibility?.() ?? true);
  const x = Math.ceil(rect.left);
  const y = Math.ceil(rect.top);
  const box = { x, y, width: Math.max(0, Math.floor(rect.right) - x), height: Math.max(0, Math.floor(rect.bottom) - y) };
  return { ...box, visible: shown, ...stacking(host, box, overlays) };
}
function bodyLayer(el, host, overlays) {
  if (el.parentElement !== document.body) return true;
  if (el.contains(host) || overlays.includes(el)) return false;
  const style = getComputedStyle(el);
  return (style.position === "fixed" || style.position === "absolute") && style.pointerEvents !== "none";
}
function stacking(host, box, overlays = []) {
  const layers = [...document.querySelectorAll(`body > *, ${LAYERS}`)].filter((el) => bodyLayer(el, host, overlays));
  const key = (el) => (Number(getComputedStyle(el).zIndex) || 0) * 4096 + layers.indexOf(el);
  const own = host.closest(LAYERS);
  const z = own ? key(own) : 0;
  const holes = [];
  const cover = (el) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(box.x, Math.floor(r.left)), top = Math.max(box.y, Math.floor(r.top));
    const right = Math.min(box.x + box.width, Math.ceil(r.right)), bottom = Math.min(box.y + box.height, Math.ceil(r.bottom));
    if (right > left && bottom > top) holes.push({ x: left - box.x, y: top - box.y, width: right - left, height: bottom - top });
  };
  for (const layer of layers) if (layer !== own && key(layer) > z) cover(layer);
  for (const overlay of overlays) if (overlay.isConnected) cover(overlay);
  return { z, holes };
}
const sameBox = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const same = (a, b) => !!a && sameBox(a, b) && a.visible === b.visible && a.z === b.z && a.holes.length === b.holes.length && a.holes.every((h, i) => sameBox(h, b.holes[i]));
function initial(url) {
  return { url, title: "", loading: true, progress: 0, canGoBack: false, canGoForward: false, error: null };
}
let next = 1;
const FIELDS = ["url", "title", "loading", "progress", "canGoBack", "canGoForward", "error", "discarded"];
class View {
  id = `wv${next++}`;
  host;
  options;
  state;
  adopted = false;
  backend;
  onClose;
  listeners = /* @__PURE__ */ new Set();
  open = true;
  /** The native backend's: the last placement sent. */
  placed = null;
  /** The iframe backend's. */
  frame = null;
  constructor(host, options, backend, onClose) {
    this.host = host;
    this.options = options;
    this.backend = backend;
    this.onClose = onClose;
    this.state = initial(options.url);
    backend.open(this);
  }
  get url() {
    return this.state.url;
  }
  get title() {
    return this.state.title;
  }
  get loading() {
    return this.state.loading;
  }
  get progress() {
    return this.state.progress;
  }
  get canGoBack() {
    return this.state.canGoBack;
  }
  get canGoForward() {
    return this.state.canGoForward;
  }
  get error() {
    return this.state.error;
  }
  get proxy() {
    return this.state.proxy;
  }
  get discarded() {
    return this.state.discarded;
  }
  /** Merges `patch` into the state and tells the listeners. */
  update(patch) {
    const next2 = { ...this.state };
    let changed = false;
    for (const key of FIELDS) {
      const value = patch[key];
      if (value === void 0 || next2[key] === value) continue;
      Object.assign(next2, { [key]: value });
      changed = true;
    }
    const proxy = patch.proxy;
    if (proxy && (proxy.kind !== next2.proxy?.kind || proxy.error !== next2.proxy?.error)) {
      next2.proxy = proxy.error === void 0 ? { kind: proxy.kind } : { kind: proxy.kind, error: proxy.error };
      changed = true;
    }
    if (!changed) return;
    this.state = next2;
    for (const listener of [...this.listeners]) listener();
  }
  /** A press in the view's content, which the page did not see: told as a pointerdown on the
   *  host, so that whatever focuses a window on a press (the layout) does it here too. */
  press() {
    if (!this.open) return;
    this.host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse", isPrimary: true }));
  }
  navigate(url) {
    if (this.open) this.backend.navigate(this, url);
  }
  back() {
    if (this.open) this.backend.back(this);
  }
  forward() {
    if (this.open) this.backend.forward(this);
  }
  reload() {
    if (this.open) this.backend.reload(this);
  }
  stop() {
    if (this.open) this.backend.stop(this);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    if (!this.open) return;
    this.open = false;
    this.backend.close(this);
    this.listeners.clear();
    this.onClose(this);
  }
}
class Native {
  name = "native";
  features = Object.freeze({ profiles: true, proxy: true });
  post;
  overlays;
  constructor(post, overlays) {
    this.post = post;
    this.overlays = overlays;
  }
  open(view) {
    const { profile, key } = view.options;
    this.post({ op: "create", id: view.id, url: view.options.url, ...profile && { profile }, ...key && { key } });
    this.place(view);
  }
  /** Measures the host and sends its place when it moved. */
  place(view) {
    const now = placement(view.host, this.overlays());
    if (same(view.placed, now)) return;
    view.placed = now;
    this.post({ op: "place", id: view.id, ...now });
  }
  navigate(view, url) {
    view.update({ url, loading: true, progress: 0, error: null });
    this.post({ op: "navigate", id: view.id, url });
  }
  back(view) {
    this.post({ op: "back", id: view.id });
  }
  forward(view) {
    this.post({ op: "forward", id: view.id });
  }
  reload(view) {
    this.post({ op: "reload", id: view.id });
  }
  stop(view) {
    this.post({ op: "stop", id: view.id });
  }
  close(view) {
    this.post({ op: "dispose", id: view.id });
  }
}
class Frame {
  name = "iframe";
  features = Object.freeze({ profiles: false, proxy: false });
  open(view) {
    const frame = document.createElement("iframe");
    frame.className = "webview";
    frame.style.cssText = "display: block; border: 0; width: 100%; height: 100%; background: transparent;";
    frame.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write; autoplay");
    frame.addEventListener("load", () => view.update({ loading: false, progress: 1, ...this.readable(frame) }));
    frame.src = view.options.url;
    view.frame = frame;
    view.host.append(frame);
  }
  /** What a same-origin page lets us read; nothing for a foreign one. */
  readable(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc) return {};
      return { title: doc.title, url: doc.URL };
    } catch {
      return {};
    }
  }
  /** The frame's window when the page is ours to drive, else null. */
  inside(view) {
    try {
      const win = view.frame?.contentWindow;
      return win && win.location.href !== void 0 ? win : null;
    } catch {
      return null;
    }
  }
  navigate(view, url) {
    if (!view.frame) return;
    view.update({ url, title: "", loading: true, progress: 0, error: null, canGoBack: false, canGoForward: false });
    view.frame.src = url;
  }
  back(view) {
    this.inside(view)?.history.back();
  }
  forward(view) {
    this.inside(view)?.history.forward();
  }
  reload(view) {
    const win = this.inside(view);
    if (win) win.location.reload();
    else if (view.frame) view.frame.src = view.state.url;
    view.update({ loading: true, progress: 0 });
  }
  stop(view) {
    this.inside(view)?.stop();
    view.update({ loading: false });
  }
  close(view) {
    view.frame?.remove();
    view.frame = null;
  }
}
const SETTLE_MS = 120;
class WebViews extends Service {
  static provide = "webviews";
  static author = "dan";
  static tags = ["browser"];
  static version = "0.1.14";
  // ui: the overlays (menus, dropdowns) the views leave to the page.
  static inject = ["ui"];
  constructor(ctx) {
    super(ctx, WebViews.provide);
    const channel = nativeChannel(HANDLER, EVENT);
    const native = channel ? new Native((body) => channel.post(body), () => ctx.ui.overlays()) : null;
    this.state = { views: [], backend: native ?? new Frame(), native, resizer: null, timer: null, frame: null };
    const onBlur = () => {
      const active = document.activeElement;
      const view = active instanceof HTMLIFrameElement ? this.state.views.find((v) => v.frame === active) : void 0;
      view?.press();
    };
    ctx.effect(() => {
      window.addEventListener("blur", onBlur);
      return () => window.removeEventListener("blur", onBlur);
    }, "webviews: iframe presses");
    if (!channel || !native) return;
    ctx.effect(() => channel.listen((event) => this.receive(event)), "webviews: native events");
    const measure = () => this.measure();
    ctx.effect(() => {
      const resizer = this.state.resizer = new ResizeObserver(measure);
      const children = (nodes) => [...nodes].filter((node) => node instanceof Element);
      for (const child of document.body.children) resizer.observe(child);
      const bodyWatch = new MutationObserver((records) => {
        for (const record of records) {
          for (const child of children(record.addedNodes)) resizer.observe(child);
          for (const child of children(record.removedNodes)) resizer.unobserve(child);
        }
        measure();
      });
      bodyWatch.observe(document.body, { childList: true });
      window.addEventListener("resize", measure);
      document.addEventListener("scroll", measure, true);
      document.addEventListener("transitionend", measure, true);
      return () => {
        bodyWatch.disconnect();
        this.state.resizer?.disconnect();
        this.state.resizer = null;
        window.removeEventListener("resize", measure);
        document.removeEventListener("scroll", measure, true);
        document.removeEventListener("transitionend", measure, true);
        if (this.state.timer) clearTimeout(this.state.timer);
        if (this.state.frame) cancelAnimationFrame(this.state.frame);
      };
    }, "webviews: placement");
    ctx.on("layout/change", (change) => {
      if (change?.kind !== "title") measure();
    });
    ctx.on("ui/overlay", measure);
    ctx.effect(() => () => {
      for (const view of [...this.state.views]) view.dispose();
    }, "webviews: views");
  }
  get backend() {
    return this.state.backend.name;
  }
  get features() {
    return this.state.backend.features;
  }
  create(host, options) {
    const { views, backend, native, resizer } = this.state;
    const view = new View(host, options, backend, (closed) => {
      const at = views.indexOf(closed);
      if (at >= 0) views.splice(at, 1);
      resizer?.unobserve(closed.host);
    });
    views.push(view);
    if (native) resizer?.observe(host);
    this.ctx.effect(() => () => view.dispose(), "webviews.create()");
    return view;
  }
  list() {
    return [...this.state.views];
  }
  /** Measures every view on the next frame, and once more when the layout's transitions are done. */
  measure() {
    const { native } = this.state;
    if (!native) return;
    if (this.state.frame === null) {
      this.state.frame = requestAnimationFrame(() => {
        this.state.frame = null;
        for (const view of this.state.views) native.place(view);
      });
    }
    if (this.state.timer) clearTimeout(this.state.timer);
    this.state.timer = setTimeout(() => {
      this.state.timer = null;
      for (const view of this.state.views) native.place(view);
    }, SETTLE_MS);
  }
  receive(detail) {
    const view = this.state.views.find((v) => v.id === detail.id);
    if (!view) return;
    if (detail.type === "press") return view.press();
    if (detail.type === "open") {
      if (!detail.open) return;
      if (view.options.onOpen) view.options.onOpen(detail.open);
      else view.navigate(detail.open);
      return;
    }
    if (detail.adopted) view.adopted = true;
    const state = {};
    for (const key of FIELDS) if (detail[key] !== void 0) Object.assign(state, { [key]: detail[key] });
    if (detail.proxy) state.proxy = detail.proxy;
    view.update(state);
  }
}
var webviews_default = WebViews;
export {
  EVENT,
  HANDLER,
  webviews_default as default,
  initial,
  placement,
  stacking
};
//# sourceMappingURL=index.js.map
