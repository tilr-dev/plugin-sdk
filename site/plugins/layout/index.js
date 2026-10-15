import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { SelectionHub } from "../../selection.js";
import { Service } from "cordis";
import { memo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { performanceCollector } from "../../performance.js";
import { mark, measure, metric } from "tilr";
const DEFAULT_SIZE = { width: 480, height: 320 };
const MIN = 80;
const TEAR = 24;
const RATIO = { min: 0.1, max: 0.9 };
const ZERO = { x: 0, y: 0, width: 0, height: 0 };
function leaves(node) {
  if (node === null) return [];
  return typeof node === "string" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}
function filter(node, keep) {
  if (node === null) return null;
  if (typeof node === "string") return keep(node) ? node : null;
  const a = filter(node.a, keep);
  const b = filter(node.b, keep);
  if (a === null) return b;
  if (b === null) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}
function remove(node, id) {
  return filter(node, (leaf) => leaf !== id);
}
function insert(node, id, at, rects) {
  if (node === null) return id;
  const all = leaves(node);
  const target = at !== null && all.includes(at) ? at : all[all.length - 1];
  const rect = rects.get(target);
  const dir = rect && rect.height > rect.width ? "col" : "row";
  const split = (n) => {
    if (typeof n === "string") return n === target ? { dir, ratio: 0.5, a: n, b: id } : n;
    return { ...n, a: split(n.a), b: split(n.b) };
  };
  return split(node);
}
const EDGE = 24;
function sideOf(rect, point) {
  const fx = (point.x - rect.x) / Math.max(1, rect.width);
  const fy = (point.y - rect.y) / Math.max(1, rect.height);
  const distance = { w: fx, e: 1 - fx, n: fy, s: 1 - fy };
  return Object.keys(distance).reduce((best, side) => distance[side] < distance[best] ? side : best, "w");
}
function half(rect, side, gap) {
  const width = Math.round(Math.max(0, rect.width - gap) / 2);
  const height = Math.round(Math.max(0, rect.height - gap) / 2);
  switch (side) {
    case "w":
      return { x: rect.x, y: rect.y, width, height: rect.height };
    case "e":
      return { x: rect.x + rect.width - width, y: rect.y, width, height: rect.height };
    case "n":
      return { x: rect.x, y: rect.y, width: rect.width, height };
    case "s":
      return { x: rect.x, y: rect.y + rect.height - height, width: rect.width, height };
  }
}
function bounds(node, rects) {
  const all = leaves(node).map((id) => rects.get(id)).filter((r) => r !== void 0);
  if (all.length === 0) return null;
  const x = Math.min(...all.map((r) => r.x)), y = Math.min(...all.map((r) => r.y));
  const right = Math.max(...all.map((r) => r.x + r.width)), bottom = Math.max(...all.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}
const edgeOf = (rect, side) => side === "w" ? rect.x : side === "e" ? rect.x + rect.width : side === "n" ? rect.y : rect.y + rect.height;
function findDrop(node, rects, inner, point, gap) {
  const inside = (r) => point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height;
  if (!inside(inner)) return null;
  if (node === null) return { path: [], side: "w", rect: inner };
  const chain = [];
  const walk = (n, path) => {
    if (typeof n === "string") {
      const rect2 = rects.get(n);
      if (!rect2 || !inside(rect2)) return false;
      chain.push({ path, rect: rect2 });
      return true;
    }
    const rect = bounds(n, rects);
    if (!rect || !inside(rect)) return false;
    chain.push({ path, rect });
    if (walk(n.a, [...path, 0]) || walk(n.b, [...path, 1])) return true;
    chain.pop();
    return false;
  };
  if (!walk(node, [])) return null;
  const tile = chain[chain.length - 1];
  const side = sideOf(tile.rect, point);
  const edge = edgeOf(tile.rect, side);
  const distance = side === "w" || side === "e" ? Math.abs(point.x - edge) : Math.abs(point.y - edge);
  const sharing = chain.slice(0, -1).filter((n) => Math.abs(edgeOf(n.rect, side) - edge) < 1);
  const band = Math.floor(distance / EDGE);
  const at = band < sharing.length ? sharing[band] : tile;
  return { path: at.path, side, rect: half(at.rect, side, gap) };
}
function insertAt(node, id, path, side) {
  if (node === null) return path.length === 0 ? id : null;
  if (path.length === 0) {
    const dir = side === "w" || side === "e" ? "row" : "col";
    const first = side === "w" || side === "n";
    return { dir, ratio: 0.5, a: first ? id : node, b: first ? node : id };
  }
  if (typeof node === "string") return null;
  const [head, ...rest] = path;
  const child = insertAt(head === 0 ? node.a : node.b, id, rest, side);
  if (child === null) return null;
  return head === 0 ? { ...node, a: child } : { ...node, b: child };
}
function setRatio(node, path, ratio) {
  if (typeof node === "string") return node;
  if (path.length === 0) return { ...node, ratio: Math.min(RATIO.max, Math.max(RATIO.min, ratio)) };
  const [head, ...rest] = path;
  return head === 0 ? { ...node, a: setRatio(node.a, rest, ratio) } : { ...node, b: setRatio(node.b, rest, ratio) };
}
function place(node, canvas, gap) {
  const rects = /* @__PURE__ */ new Map();
  const gutters = [];
  const strip = Math.max(gap, 6);
  const walk = (n, rect, path) => {
    if (typeof n === "string") {
      rects.set(n, rect);
      return;
    }
    if (n.dir === "row") {
      const inner = Math.max(0, rect.width - gap);
      const wa = Math.round(inner * n.ratio);
      walk(n.a, { x: rect.x, y: rect.y, width: wa, height: rect.height }, [...path, 0]);
      walk(n.b, { x: rect.x + wa + gap, y: rect.y, width: inner - wa, height: rect.height }, [...path, 1]);
      gutters.push({ path, dir: "row", span: rect, rect: { x: rect.x + wa + (gap - strip) / 2, y: rect.y, width: strip, height: rect.height } });
    } else {
      const inner = Math.max(0, rect.height - gap);
      const ha = Math.round(inner * n.ratio);
      walk(n.a, { x: rect.x, y: rect.y, width: rect.width, height: ha }, [...path, 0]);
      walk(n.b, { x: rect.x, y: rect.y + ha + gap, width: rect.width, height: inner - ha }, [...path, 1]);
      gutters.push({ path, dir: "col", span: rect, rect: { x: rect.x, y: rect.y + ha + (gap - strip) / 2, width: rect.width, height: strip } });
    }
  };
  if (node !== null) walk(node, canvas, []);
  return { rects, gutters };
}
function padding(element) {
  const style = getComputedStyle(element);
  const px = (value) => parseFloat(value) || 0;
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}
const same = (a, b) => a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
function clamp(rect, canvas) {
  const width = Math.max(MIN, rect.width);
  const height = Math.max(MIN, rect.height);
  const x = Math.min(Math.max(rect.x, MIN - width), Math.max(0, canvas.width - MIN));
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, canvas.height - MIN));
  return { x, y, width, height };
}
const EMPTY = { windows: [], tree: null, floats: [], focus: null, seen: [], ghosts: {} };
function ghostOf(node, id) {
  if (node === null || typeof node === "string") return null;
  for (const side of ["a", "b"]) {
    if (node[side] === id) {
      const other = leaves(node[side === "a" ? "b" : "a"]);
      return { mode: "tile", sibling: other[0], side, dir: node.dir, ratio: node.ratio };
    }
  }
  return ghostOf(node.a, id) ?? ghostOf(node.b, id);
}
function revive(node, id, ghost) {
  if (node === null || !leaves(node).includes(ghost.sibling)) return null;
  const split = (n) => {
    if (typeof n === "string") {
      if (n !== ghost.sibling) return n;
      return ghost.side === "a" ? { dir: ghost.dir, ratio: ghost.ratio, a: id, b: n } : { dir: ghost.dir, ratio: ghost.ratio, a: n, b: id };
    }
    return { ...n, a: split(n.a), b: split(n.b) };
  };
  return split(node);
}
function restore(raw) {
  try {
    if (!raw || typeof raw !== "object") return structuredClone(EMPTY);
    const data = raw;
    const stored = (Array.isArray(data.windows) ? data.windows : []).filter((w) => !!w && typeof w === "object" && typeof w.id === "string" && typeof w.type === "string");
    const ids = new Set(stored.map((w) => w.id));
    const windows = stored.map((w) => {
      const parent = w.mode === "nested" && typeof w.parent === "string" && ids.has(w.parent) && w.parent !== w.id ? w.parent : null;
      return { ...w, transient: false, parent, mode: parent ? "nested" : w.mode === "float" ? "float" : "tile" };
    });
    const floats = (Array.isArray(data.floats) ? data.floats : []).filter((id) => typeof id === "string" && ids.has(id));
    let tree = filter(data.tree ?? null, (id) => ids.has(id) && windows.some((w) => w.id === id && w.mode === "tile"));
    for (const w of windows) if (w.mode === "tile" && !leaves(tree).includes(w.id)) tree = insert(tree, w.id, null, /* @__PURE__ */ new Map());
    return {
      windows,
      tree,
      floats: floats.filter((id) => windows.some((w) => w.id === id && w.mode === "float")),
      focus: typeof data.focus === "string" && ids.has(data.focus) ? data.focus : null,
      seen: (Array.isArray(data.seen) ? data.seen : []).filter((t) => typeof t === "string"),
      ghosts: data.ghosts && typeof data.ghosts === "object" ? data.ghosts : {}
    };
  } catch {
    return structuredClone(EMPTY);
  }
}
function kept(data) {
  const windows = data.windows.filter((w) => !w.transient).map(({ id, type, title, config, mode, rect, transient, parent }) => ({ id, type, title, config, mode, rect, transient, parent }));
  const ids = new Set(windows.map((w) => w.id));
  return {
    // A transient parent is not saved: its children come back as tiles (restore() repairs them).
    windows: windows.map((w) => w.parent !== null && !ids.has(w.parent) ? { ...w, parent: null, mode: "tile" } : w),
    tree: filter(data.tree, (id) => ids.has(id)),
    floats: data.floats.filter((id) => ids.has(id)),
    focus: data.focus !== null && ids.has(data.focus) ? data.focus : null,
    seen: data.seen,
    ghosts: data.ghosts
  };
}
function splitState(data) {
  const saved = kept(data);
  return {
    windows: { version: 1, instances: Object.fromEntries(saved.windows.map(({ id, type, title, config }) => [id, { id, type, title, config }])), initializedTypes: [...saved.seen] },
    layout: { version: 1, placements: Object.fromEntries(saved.windows.map(({ id, mode, rect, parent }) => [id, { mode, rect, parent }])), tree: saved.tree, floats: saved.floats, focus: saved.focus, ghosts: saved.ghosts }
  };
}
function restoreState(rawWindows, rawLayout) {
  const windows = rawWindows;
  const layout = rawLayout;
  if (windows?.version === 1 && windows.instances && typeof windows.instances === "object") {
    const placements = layout?.placements ?? {};
    const instances = Object.values(windows.instances).filter((w) => w && typeof w.id === "string" && typeof w.type === "string");
    return restore({
      ...layout,
      windows: instances.map((w) => ({ ...w, ...placements[w.id] ?? { mode: "tile", rect: { ...ZERO, ...DEFAULT_SIZE }, parent: null } })),
      seen: [.../* @__PURE__ */ new Set([...Array.isArray(windows.initializedTypes) ? windows.initializedTypes.filter((t) => typeof t === "string") : [], ...instances.map((w) => w.type)])]
    });
  }
  const legacy = restore(rawLayout);
  legacy.seen = [.../* @__PURE__ */ new Set([...legacy.seen, ...legacy.windows.map((w) => w.type), ...Object.keys(legacy.ghosts)])];
  return legacy;
}
function allowed(def) {
  const modes = def?.modes?.filter((m, i, all) => (m === "tile" || m === "float") && all.indexOf(m) === i) ?? [];
  return modes.length ? modes : ["tile", "float"];
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
class Layout extends Service {
  static provide = "layout";
  static inject = ["ui", "windows", "store"];
  static author = "dan";
  static tags = ["layout", "window-manager"];
  static version = "0.1.14";
  constructor(ctx) {
    super(ctx, "layout");
    this.scope = ctx;
    const area = ctx.store.area("layout");
    const windowsArea = ctx.store.area("windows");
    this.state = { data: restoreState(structuredClone(windowsArea.get("state")), structuredClone(area.get("data"))), area, windowsArea, canvas: { width: 0, height: 0 }, pad: { top: 0, right: 0, bottom: 0, left: 0 }, gap: 16, version: 0, listeners: /* @__PURE__ */ new Set(), canvasListeners: /* @__PURE__ */ new Set(), selections: new SelectionHub(), handles: /* @__PURE__ */ new Map(), tiles: /* @__PURE__ */ new Map(), gutters: [], blind: [], drop: null, slots: /* @__PURE__ */ new Map(), element: null };
    this.measure();
    ctx.on("windows/change", () => this.sweep());
    this.sweep();
    ctx.ui.style(CSS);
    ctx.effect(() => {
      const grid = document.getElementById("grid");
      const canvas = document.createElement("div");
      canvas.className = "tilr-canvas";
      if (performanceCollector) canvas.dataset.perfPlugin = "layout";
      grid.classList.add("tilr-layout");
      grid.append(canvas);
      this.state.element = canvas;
      const observer = new ResizeObserver(() => this.resize(canvas));
      observer.observe(canvas);
      observer.observe(document.body);
      this.resize(canvas);
      const root = createRoot(canvas);
      root.render(/* @__PURE__ */ jsx(Canvas, { layout: this }));
      return () => {
        observer.disconnect();
        root.unmount();
        canvas.remove();
        this.state.element = null;
        this.state.slots.clear();
        grid.classList.remove("tilr-layout");
      };
    }, "layout canvas");
  }
  // --- the public service (LayoutApi) ---
  open(spec, options) {
    if (options?.from && spec.parent === void 0) {
      const claimed = this.scope.bail("window/open", { spec, from: options.from });
      if (typeof claimed === "string") return claimed;
    }
    const { data } = this.state;
    const def = this.scope.windows.get(spec.type);
    if (def?.singleton || def?.open === "always") {
      const existing = data.windows.find((w) => w.type === spec.type);
      if (existing) {
        this.focus(existing.id);
        return existing.id;
      }
    }
    if (!spec.transient && !data.seen.includes(spec.type)) data.seen.push(spec.type);
    const id = uid();
    const parent = spec.parent !== void 0 && data.windows.some((w) => w.id === spec.parent) ? spec.parent : null;
    const ghost = parent ? void 0 : data.ghosts[spec.type];
    if (!parent) delete data.ghosts[spec.type];
    const modes = allowed(def);
    const wanted = spec.mode ?? (ghost && !spec.rect ? ghost.mode : void 0) ?? def?.mode ?? "tile";
    const mode = parent ? "nested" : modes.includes(wanted) ? wanted : modes[0];
    const win = {
      id,
      type: spec.type,
      title: spec.title ?? null,
      config: spec.config ?? def?.defaultConfig,
      mode,
      rect: ghost?.mode === "float" && !spec.rect ? ghost.rect : this.floatRect(spec.rect, def?.size),
      transient: !!spec.transient,
      parent
    };
    data.windows.push(win);
    if (mode === "tile") {
      data.tree = (ghost?.mode === "tile" ? revive(data.tree, id, ghost) : null) ?? insert(data.tree, id, data.focus, this.state.tiles);
      if (!this.state.canvas.width || !this.state.canvas.height) this.state.blind.push(id);
    } else if (mode === "float") data.floats.push(id);
    data.focus = id;
    mark(`window:open ${spec.type}`);
    this.changed();
    return id;
  }
  close(id) {
    const { data } = this.state;
    const win = data.windows.find((w) => w.id === id);
    if (!win) return;
    for (const child of this.children(id)) {
      const row = data.windows.find((w) => w.id === child);
      if (row && this.modes(row).includes("tile")) this.tile(child);
      else this.float(child);
    }
    mark(`window:close ${win.type}`);
    const ghost = win.mode === "tile" ? ghostOf(data.tree, id) : win.mode === "float" ? { mode: "float", rect: win.rect } : null;
    if (ghost) data.ghosts[win.type] = ghost;
    data.windows = data.windows.filter((w) => w.id !== id);
    data.tree = remove(data.tree, id);
    data.floats = data.floats.filter((f) => f !== id);
    this.state.handles.delete(id);
    this.state.slots.delete(id);
    if (this.state.drop?.id === id) this.state.drop = null;
    if (data.focus === id) {
      const next = win.parent !== null ? this.children(win.parent)[0] ?? win.parent : void 0;
      data.focus = next ?? data.floats[data.floats.length - 1] ?? leaves(data.tree).pop() ?? null;
    }
    this.changed();
  }
  float(id, rect = {}) {
    const { data } = this.state;
    const win = data.windows.find((w) => w.id === id);
    if (!win || !this.modes(win).includes("float")) return;
    if (win.mode !== "float") {
      const current = this.rectOf(win);
      this.detach(win);
      win.mode = "float";
      win.rect = current.width && current.height ? { ...current } : win.rect;
    }
    win.rect = clamp({ ...win.rect, ...rect }, this.state.canvas);
    data.floats = [...data.floats.filter((f) => f !== id), id];
    data.focus = id;
    this.changed();
  }
  /** Back into the tree: at `at` (a drop from a drag), else next to the focused tile. */
  tile(id, at) {
    const { data } = this.state;
    const win = data.windows.find((w) => w.id === id);
    if (!win || win.mode === "tile" || !this.modes(win).includes("tile")) return;
    this.detach(win);
    win.mode = "tile";
    data.tree = (at && insertAt(data.tree, id, at.path, at.side)) ?? insert(data.tree, id, data.focus === id ? null : data.focus, this.state.tiles);
    data.focus = id;
    if (this.state.drop?.id === id) this.state.drop = null;
    this.changed();
  }
  adopt(id, parent) {
    const { data } = this.state;
    const win = data.windows.find((w) => w.id === id);
    if (!win || win.parent === parent || id === parent || !data.windows.some((w) => w.id === parent)) return;
    if (this.ancestors(parent).includes(id)) return;
    this.detach(win);
    win.mode = "nested";
    win.parent = parent;
    data.windows = [...data.windows.filter((w) => w.id !== id), win];
    data.focus = id;
    if (this.state.drop?.id === id) this.state.drop = null;
    this.changed();
  }
  focus(id) {
    const { data } = this.state;
    const win = data.windows.find((w) => w.id === id);
    if (!win) return;
    const outer = this.ancestors(id).pop() ?? id;
    const raise = data.windows.find((w) => w.id === outer)?.mode === "float" && data.floats[data.floats.length - 1] !== outer;
    if (raise) data.floats = [...data.floats.filter((f) => f !== outer), outer];
    else if (data.focus === id) return;
    data.focus = id;
    this.changed();
  }
  setTitle(id, title) {
    const win = this.state.data.windows.find((w) => w.id === id);
    if (!win || win.title === title) return;
    win.title = title;
    this.changed(true, id);
  }
  setConfig(id, config) {
    const win = this.state.data.windows.find((w) => w.id === id);
    if (!win) return;
    win.config = config;
    this.changed();
  }
  get(id) {
    const win = this.state.data.windows.find((w) => w.id === id);
    return win && this.row(win);
  }
  list() {
    return this.state.data.windows.map((w) => this.row(w));
  }
  // --- for the canvas (the class, not the LayoutApi plugins see) ---
  /** A floating window's rect while it is dragged or resized; `final` saves it. */
  move(id, rect, final) {
    const win = this.state.data.windows.find((w) => w.id === id);
    if (!win || win.mode !== "float") return;
    win.rect = clamp(rect, this.state.canvas);
    this.changed(final);
  }
  /** Where the float `id`, dragged with the modifier to `point` (canvas coordinates), would
   *  land; shown as the preview until the next call. Null (or no point) clears it. */
  drop(id, point) {
    const { data, tiles, gap } = this.state;
    const at = point && findDrop(data.tree, tiles, this.inner(), point, gap);
    const was = this.state.drop;
    this.state.drop = at ? { id, at } : null;
    if (was !== null || at !== null) this.changed(false);
    return at;
  }
  ratio(path, ratio, final) {
    const { data } = this.state;
    if (data.tree === null) return;
    data.tree = setRatio(data.tree, path, ratio);
    this.changed(final);
  }
  /** The window as its type sees it: one object per window, reading the state as it is now. */
  handle(id) {
    const have = this.state.handles.get(id);
    if (have) return have;
    const row = () => this.get(id);
    const raw = () => this.state.data.windows.find((w) => w.id === id);
    const layout = this;
    const children = () => this.children(id).flatMap((child) => this.get(child) ?? []);
    const handle = {
      id,
      get type() {
        return raw()?.type ?? "";
      },
      get title() {
        const win = raw();
        return win ? layout.titleOf(win) : "";
      },
      get config() {
        return raw()?.config;
      },
      get mode() {
        return raw()?.mode ?? "tile";
      },
      get modes() {
        const win = raw();
        return win ? layout.modes(win) : ["tile", "float"];
      },
      get rect() {
        return row()?.rect ?? ZERO;
      },
      get focused() {
        return layout.state.data.focus === id;
      },
      get parent() {
        return raw()?.parent ?? null;
      },
      get children() {
        return children();
      },
      setConfig: (config) => this.setConfig(id, config),
      setTitle: (title) => this.setTitle(id, title),
      requestFloat: (rect) => this.float(id, rect),
      requestTile: () => this.tile(id),
      focus: () => this.focus(id),
      close: () => this.close(id),
      place: (child, host) => this.place(id, child, host),
      subscribe: (listener, fields) => fields ? this.state.selections.subscribe(fields.map((field) => `${id}:${field}`), () => fields.map((field) => handle[field]), listener) : this.subscribe(listener)
    };
    this.state.handles.set(id, handle);
    return handle;
  }
  windowType(type) {
    return this.scope.windows.get(type);
  }
  subscribe(listener) {
    this.state.listeners.add(listener);
    return () => {
      this.state.listeners.delete(listener);
    };
  }
  // --- internals ---
  /** The modes the window's type allows (both while the type is away). */
  modes(win) {
    return allowed(this.scope.windows.get(win.type));
  }
  titleOf(win) {
    const def = this.scope.windows.get(win.type);
    return win.title ?? (typeof def?.title === "function" ? def.title(win.config) : def?.title) ?? win.type;
  }
  row(win) {
    const def = this.scope.windows.get(win.type);
    const fallback = typeof def?.title === "function" ? def.title(win.config) : def?.title;
    return {
      id: win.id,
      type: win.type,
      title: win.title ?? fallback ?? win.type,
      config: win.config,
      mode: win.mode,
      modes: allowed(def),
      rect: this.rectOf(win),
      focused: this.state.data.focus === win.id,
      mounted: !!def,
      transient: win.transient,
      parent: win.parent,
      children: this.children(win.id)
    };
  }
  /** Where the window is, in canvas coordinates: its tile, its float rect, or the element its
   *  parent placed it in (zero while it has none, or the canvas is not mounted). */
  rectOf(win) {
    if (win.mode === "tile") return this.state.tiles.get(win.id) ?? ZERO;
    if (win.mode === "float") return win.rect;
    const slot = this.state.slots.get(win.id);
    const canvas = this.state.element;
    if (!slot || !canvas || !slot.isConnected) return ZERO;
    const s = slot.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    return { x: s.x - c.x, y: s.y - c.y, width: s.width, height: s.height };
  }
  /** Takes the window out of where it is: the tree, the floats, or its parent. */
  detach(win) {
    const { data } = this.state;
    if (win.mode === "tile") data.tree = remove(data.tree, win.id);
    else if (win.mode === "float") data.floats = data.floats.filter((f) => f !== win.id);
    else {
      win.parent = null;
      this.state.slots.delete(win.id);
    }
  }
  /** The windows nested in `id`, in opening order. */
  children(id) {
    return this.state.data.windows.filter((w) => w.parent === id).map((w) => w.id);
  }
  /** The window's parent, its parent's parent, … outwards. */
  ancestors(id) {
    const chain = [];
    const seen = /* @__PURE__ */ new Set([id]);
    let at = this.state.data.windows.find((w) => w.id === id)?.parent ?? null;
    while (at !== null && !seen.has(at)) {
      chain.push(at);
      seen.add(at);
      at = this.state.data.windows.find((w) => w.id === at)?.parent ?? null;
    }
    return chain;
  }
  /** `WindowHandle.place`: the parent says where its child is drawn. */
  place(parent, child, host) {
    const win = this.state.data.windows.find((w) => w.id === child);
    if (!win || win.parent !== parent) return;
    const was = this.state.slots.get(child) ?? null;
    if (was === host) return;
    was?.classList.remove("tilr-slot");
    if (host) {
      host.classList.add("tilr-slot");
      this.state.slots.set(child, host);
    } else this.state.slots.delete(child);
    this.changed(false);
  }
  /** The parent's content is gone (its type unmounted): its children have no place. */
  unplace(parent) {
    let any = false;
    for (const child of this.children(parent)) {
      const was = this.state.slots.get(child);
      if (!was) continue;
      was.classList.remove("tilr-slot");
      this.state.slots.delete(child);
      any = true;
    }
    if (any) this.changed(false);
  }
  /** Where a new float goes: `rect` over a cascade of default-sized rects. */
  floatRect(rect, size) {
    const n = this.state.data.floats.length;
    const base = { x: 40 + 24 * n, y: 40 + 24 * n, ...size ?? DEFAULT_SIZE };
    return clamp({ ...base, ...rect }, this.state.canvas);
  }
  /** Registration affects rendering, not the user's decision to open or close a window. */
  sweep() {
    const { data } = this.state;
    const { windows } = this.scope;
    for (const type of windows.list()) {
      const def = windows.get(type);
      const open = def?.open ?? "once";
      for (const win of data.windows) {
        if (win.type !== type || win.mode === "nested" || allowed(def).includes(win.mode)) continue;
        if (win.mode === "float") this.tile(win.id);
        else {
          const at = this.state.tiles.get(win.id) ?? win.rect;
          this.float(win.id, { x: at.x, y: at.y, ...def?.size ?? DEFAULT_SIZE });
        }
      }
      if (open !== "never" && !data.seen.includes(type)) {
        data.seen.push(type);
        this.open({ type });
      }
    }
    this.changed();
  }
  resize(canvas) {
    const pad = padding(document.body);
    canvas.style.inset = `${-pad.top}px ${-pad.right}px ${-pad.bottom}px ${-pad.left}px`;
    const { width, height } = canvas.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(canvas).getPropertyValue("--gap")) || 16;
    const state = this.state;
    if (state.canvas.width === width && state.canvas.height === height && state.gap === gap && same(state.pad, pad)) return;
    state.canvas = { width, height };
    state.pad = pad;
    state.gap = gap;
    if (width > 0 && height > 0) {
      for (const win of state.data.windows) if (win.mode === "float") win.rect = clamp(win.rect, state.canvas);
    }
    if (state.blind.length && width && height) {
      const { data } = state;
      const blind = state.blind.filter((id) => data.windows.some((w) => w.id === id && w.mode === "tile"));
      state.blind = [];
      for (const id of blind) data.tree = remove(data.tree, id);
      let previous = null;
      for (const id of blind) {
        this.measure();
        data.tree = insert(data.tree, id, previous, state.tiles);
        previous = id;
      }
      this.changed();
      return;
    }
    this.changed(false);
  }
  /** The tiles' part of the canvas: the canvas minus the body's padding. */
  inner() {
    const { canvas, pad } = this.state;
    return { x: pad.left, y: pad.top, width: Math.max(0, canvas.width - pad.left - pad.right), height: Math.max(0, canvas.height - pad.top - pad.bottom) };
  }
  measure() {
    const { data, gap } = this.state;
    const placed = place(data.tree, this.inner(), gap);
    this.state.tiles = placed.rects;
    this.state.gutters = placed.gutters;
  }
  changed(persist = true, titleId) {
    const started = performanceCollector ? performance.now() : 0;
    if (titleId === void 0) {
      this.measure();
      this.state.version++;
    }
    if (persist) {
      const saved = splitState(this.state.data);
      this.state.windowsArea.set("state", saved.windows);
      if (titleId === void 0) this.state.area.set("data", saved.layout);
    }
    if (titleId === void 0) {
      this.state.selections.notify();
      for (const listener of [...this.state.canvasListeners]) listener();
    } else {
      this.state.selections.notify([`${titleId}:title`, ...this.ancestors(titleId).map((id) => `${id}:children`)]);
    }
    for (const listener of [...this.state.listeners]) listener();
    this.scope.emit("layout/change", titleId === void 0 ? void 0 : { kind: "title", id: titleId });
    if (started) {
      measure("layout:change", started);
      metric("layout.change", performance.now() - started);
    }
  }
}
const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
function sameWindow(a, b) {
  return a.layout === b.layout && a.def === b.def && a.z === b.z && a.focused === b.focused && a.dropping === b.dropping && a.row.id === b.row.id && a.row.type === b.row.type && a.row.mode === b.row.mode && sameRect(a.row.rect, b.row.rect) && a.row.modes.length === b.row.modes.length && a.row.modes.every((mode, i) => mode === b.row.modes[i]);
}
function sameGutter(a, b) {
  const g = a.gutter, h = b.gutter;
  return a.layout === b.layout && g.dir === h.dir && sameRect(g.rect, h.rect) && sameRect(g.span, h.span) && g.path.length === h.path.length && g.path.every((step, i) => step === h.path[i]);
}
function Canvas({ layout }) {
  const subscribe = useCallback((listener) => {
    layout.state.canvasListeners.add(listener);
    return () => {
      layout.state.canvasListeners.delete(listener);
    };
  }, [layout]);
  useSyncExternalStore(subscribe, () => layout.state.version);
  const { floats, focus } = layout.state.data;
  const { drop, slots } = layout.state;
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    layout.list().map((row) => {
      const window2 = /* @__PURE__ */ jsx(MemoWindow, { row, def: layout.windowType(row.type), layout, z: row.mode === "float" ? 1 + floats.indexOf(row.id) : 0, focused: row.id === focus, dropping: drop?.id === row.id }, row.id);
      if (row.mode !== "nested") return window2;
      const slot = slots.get(row.id);
      return slot ? createPortal(window2, slot, row.id) : null;
    }),
    layout.state.gutters.map((gutter) => /* @__PURE__ */ jsx(MemoGutterStrip, { gutter, layout }, gutter.path.join("."))),
    drop && /* @__PURE__ */ jsx("div", { className: "drop", style: { left: drop.at.rect.x, top: drop.at.rect.y, width: drop.at.rect.width, height: drop.at.rect.height } })
  ] });
}
const held = (event) => event.shiftKey;
const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
function Window({ row, def, layout, z, focused, dropping }) {
  const host = useRef(null);
  useEffect(() => {
    const element = host.current;
    if (!def || !element) return;
    const undo = def.mount(element, layout.handle(row.id));
    return () => {
      if (undo) undo();
      layout.unplace(row.id);
    };
  }, [def, row.id, layout]);
  const onPointerDown = (event) => {
    if (!(event.target instanceof Element)) return;
    const own = event.target.closest("[data-window]") === event.currentTarget;
    const focus = layout.state.data.focus;
    if (own && !(focus !== null && layout.ancestors(focus).includes(row.id))) layout.focus(row.id);
    if (!own || event.button !== 0 || !event.target.closest("[data-window-drag]")) return;
    const start = { x: event.clientX, y: event.clientY };
    const from = row.rect;
    const canvas = layout.state.element?.getBoundingClientRect() ?? ZERO;
    const may = (mode) => row.modes.includes(mode);
    if (row.mode !== "float" && !may("float")) return;
    let floating = row.mode === "float";
    let last = null;
    let point = { x: 0, y: 0 };
    let drop = null;
    const aim = (modifier) => {
      drop = layout.drop(row.id, modifier && may("tile") ? point : null);
    };
    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!floating) {
        if (!held(ev) || Math.hypot(dx, dy) < TEAR) return;
        floating = true;
        layout.float(row.id, { ...from, x: from.x + dx, y: from.y + dy });
      } else {
        last = { ...from, x: from.x + dx, y: from.y + dy };
        layout.move(row.id, last, false);
      }
      point = { x: ev.clientX - canvas.x, y: ev.clientY - canvas.y };
      aim(held(ev));
    };
    const key = (ev) => {
      if (ev.key === "Shift" && floating) aim(held(ev));
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    drag(event, move, () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      if (drop) layout.tile(row.id, drop);
      else {
        layout.drop(row.id, null);
        if (last) layout.move(row.id, last, true);
      }
    });
  };
  const { x, y, width, height } = row.rect;
  const style = row.mode === "nested" ? { zIndex: z } : { left: x, top: y, width, height, zIndex: z };
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: "window",
      "data-window": row.id,
      "data-type": row.type,
      "data-mode": row.mode,
      "data-focused": focused || void 0,
      "data-waiting": !def || void 0,
      "data-dropping": dropping || void 0,
      style,
      onPointerDownCapture: onPointerDown,
      children: [
        /* @__PURE__ */ jsx("div", { className: "host", ref: host }),
        !def && /* @__PURE__ */ jsx("div", { className: "placeholder", "data-window-drag": true, children: /* @__PURE__ */ jsxs("span", { className: "muted", children: [
          "waiting for ",
          row.type
        ] }) }),
        row.mode === "float" && EDGES.map((edge) => /* @__PURE__ */ jsx("div", { className: "edge", "data-edge": edge, onPointerDown: (event) => resize(event, layout, row, edge) }, edge))
      ]
    }
  );
}
const MemoWindow = memo(Window, sameWindow);
MemoWindow.displayName = "Memo(Window)";
function drag(event, move, up) {
  event.preventDefault();
  window.getSelection()?.removeAllRanges();
  document.documentElement.setAttribute("data-tilr-drag", "");
  const done = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", done);
    window.removeEventListener("pointercancel", done);
    document.documentElement.removeAttribute("data-tilr-drag");
    up(ev);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", done);
  window.addEventListener("pointercancel", done);
}
function resize(event, layout, row, edge) {
  if (event.button !== 0) return;
  event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY };
  const from = row.rect;
  let last = from;
  const move = (ev) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    let { x, y, width, height } = from;
    if (edge.includes("e")) width = Math.max(MIN, from.width + dx);
    if (edge.includes("s")) height = Math.max(MIN, from.height + dy);
    if (edge.includes("w")) {
      width = Math.max(MIN, from.width - dx);
      x = from.x + from.width - width;
    }
    if (edge.includes("n")) {
      y = Math.max(0, Math.min(from.y + dy, from.y + from.height - MIN));
      height = from.y + from.height - y;
    }
    last = { x, y, width, height };
    layout.move(row.id, last, false);
  };
  drag(event, move, () => layout.move(row.id, last, true));
}
function GutterStrip({ gutter, layout }) {
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const canvas = event.currentTarget.parentElement?.getBoundingClientRect() ?? ZERO;
    const { span, dir, path } = gutter;
    const at = (ev) => dir === "row" ? (ev.clientX - canvas.x - span.x) / Math.max(1, span.width) : (ev.clientY - canvas.y - span.y) / Math.max(1, span.height);
    drag(event, (ev) => layout.ratio(path, at(ev), false), (ev) => layout.ratio(path, at(ev), true));
  };
  const { x, y, width, height } = gutter.rect;
  return /* @__PURE__ */ jsx("div", { className: "gutter", "data-dir": gutter.dir, style: { left: x, top: y, width, height }, onPointerDown });
}
const MemoGutterStrip = memo(GutterStrip, sameGutter);
MemoGutterStrip.displayName = "Memo(GutterStrip)";
const CSS = `
  body:has(> #grid.tilr-layout) { padding: 0; overflow: hidden; }
  #grid.tilr-layout { display: block; position: relative; height: 100%; min-height: 0; }
  #grid.tilr-layout > .tilr-canvas { position: absolute; inset: 0; overflow: hidden; }   /* inset: the body's padding, set by resize() */
  .tilr-canvas > .window { position: absolute; box-sizing: border-box; border-radius: var(--radius); }
  .tilr-slot { position: relative; }
  .tilr-slot > .window { position: absolute; inset: 0; box-sizing: border-box; }
  :is(.tilr-canvas, .tilr-slot) > .window > .host { position: absolute; inset: 0; overflow: hidden; display: flex; flex-direction: column; }
  :is(.tilr-canvas, .tilr-slot) > .window > .host > * { flex: 1; min-height: 0; }
  :is(.tilr-canvas, .tilr-slot) > .window .tile { height: 100%; min-height: 0; box-sizing: border-box; margin: 0; }
  :is(.tilr-canvas, .tilr-slot) > .window .tile > .body { overflow: auto; min-height: 0; }
  :is(.tilr-canvas, .tilr-slot) > .window > .placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    border: 1px dashed var(--line); border-radius: var(--radius); box-sizing: border-box; }
  .tilr-canvas > .window[data-mode=float] { box-shadow: 0 12px 40px rgba(0, 0, 0, .55); }
  .tilr-canvas > .window[data-dropping] { opacity: .6; }
  .tilr-canvas > .drop { position: absolute; z-index: 1000; pointer-events: none; box-sizing: border-box;
    border: 2px solid var(--accent); border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 18%, transparent);
    transition: left .08s, top .08s, width .08s, height .08s; }
  :is(.tilr-canvas, .tilr-slot) > .window[data-focused]::after { content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none;
    border: 1px solid var(--accent); border-radius: var(--radius); }
  .tilr-canvas [data-window-drag] { user-select: none; -webkit-user-select: none; }
  html[data-tilr-drag], html[data-tilr-drag] * { user-select: none !important; -webkit-user-select: none !important; }
  .tilr-canvas .edge { position: absolute; z-index: 1; }
  .tilr-canvas .edge[data-edge=n] { top: -3px; left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
  .tilr-canvas .edge[data-edge=s] { bottom: -3px; left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
  .tilr-canvas .edge[data-edge=e] { right: -3px; top: 8px; bottom: 8px; width: 6px; cursor: ew-resize; }
  .tilr-canvas .edge[data-edge=w] { left: -3px; top: 8px; bottom: 8px; width: 6px; cursor: ew-resize; }
  .tilr-canvas .edge[data-edge=ne] { top: -3px; right: -3px; width: 11px; height: 11px; cursor: nesw-resize; }
  .tilr-canvas .edge[data-edge=sw] { bottom: -3px; left: -3px; width: 11px; height: 11px; cursor: nesw-resize; }
  .tilr-canvas .edge[data-edge=nw] { top: -3px; left: -3px; width: 11px; height: 11px; cursor: nwse-resize; }
  .tilr-canvas .edge[data-edge=se] { bottom: -3px; right: -3px; width: 11px; height: 11px; cursor: nwse-resize; }
  .tilr-canvas .gutter { position: absolute; z-index: 1; }
  .tilr-canvas .gutter[data-dir=row] { cursor: col-resize; }
  .tilr-canvas .gutter[data-dir=col] { cursor: row-resize; }
`;
var layout_default = Layout;
export {
  clamp,
  layout_default as default,
  filter,
  findDrop,
  ghostOf,
  half,
  insert,
  insertAt,
  kept,
  leaves,
  place,
  remove,
  restore,
  restoreState,
  revive,
  sameGutter,
  sameWindow,
  setRatio,
  sideOf,
  splitState
};
//# sourceMappingURL=index.js.map
