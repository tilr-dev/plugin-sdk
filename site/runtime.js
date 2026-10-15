import { bootPerformance, performanceCollector } from "./performance.js";
import { Context, Service } from "cordis";
import { adopt, mark, measure, metric, reactMode } from "tilr";
import { asError, hasDefault, injects, pluginNames, satisfies, stampBuild } from "./lib.js";
import { drawControls, element, FRAME } from "./dom.js";
import { Agent, closest, contractOf, describeElement, members, serviceProxy, shows } from "./agent.js";
const STORAGE_KEY = "tilr-plugins-off";
const STATE = ["pending", "loading", "active", "failed", "disposed", "unloading"];
const root = new Context();
root.logger.exporter({
  export(message) {
    const log = console[message.type] ?? console.log;
    log(`[${message.name}]`, ...message.args);
  }
});
const BLIND_AFTER = 1e3;
const blindWarned = /* @__PURE__ */ new Set();
class Windows extends Service {
  constructor(ctx) {
    super(ctx, "windows");
    this.scope = ctx;
    this.state = { types: /* @__PURE__ */ new Map(), owners: /* @__PURE__ */ new Map(), mounted: /* @__PURE__ */ new Map() };
  }
  register(type, definition) {
    this.add(this.ctx, type, definition);
  }
  /** `register` on behalf of `ctx` (the ui service registers a tile's type for its caller). */
  add(ctx, type, definition) {
    const { types, owners } = this.state;
    if (types.has(type)) throw new Error(`window type "${type}" is already registered`);
    const owner = ctx.root.get("plugins")?.owner(ctx.fiber) ?? ctx.fiber.name;
    if (performanceCollector) {
      const original = definition;
      const mount = (host2, win) => {
        host2.dataset.perfPlugin = owner ?? type;
        host2.dataset.perfWindow = win.id;
        return original.mount(host2, win);
      };
      definition = Object.create(original, { mount: { enumerable: true, value: mount } });
    }
    const def = definition;
    const wrapped = Object.create(def, {
      mount: { enumerable: true, value: (host2, win) => this.mount(type, def, host2, win) }
    });
    ctx.effect(() => {
      types.set(type, wrapped);
      owners.set(type, owner);
      this.scope.emit("windows/change");
      return () => {
        types.delete(type);
        owners.delete(type);
        this.scope.emit("windows/change");
      };
    }, "windows.register()");
  }
  /** The plugin that registered `type`, if it is registered. */
  owner(type) {
    return this.state.owners.get(type);
  }
  /** Where the window `id` is drawn and its handle, while its type has it mounted. */
  mounted(id) {
    return this.state.mounted.get(id);
  }
  /** `definition.mount`, noted in `mounted` until its undo, and the blind-window check. */
  mount(type, definition, host2, win) {
    const entry = { type, host: host2, win };
    this.state.mounted.set(win.id, entry);
    const unwatch = definition.agent?.text ? () => {
    } : this.watchBlind(type, host2, win);
    const undo = definition.mount(host2, win);
    return () => {
      unwatch();
      if (this.state.mounted.get(win.id) === entry) this.state.mounted.delete(win.id);
      if (undo) undo();
    };
  }
  /** A second after the mount: a window that shows nothing (no text, no control, no adapter
   *  text) is warned about once and counted in its plugin's a11y badge until content comes. */
  watchBlind(type, host2, win) {
    const plugins = () => this.scope.root.get("plugins");
    let counted = null;
    let observer = null;
    const uncount = () => {
      if (counted !== null) plugins()?.blind(counted, -1);
      counted = null;
    };
    const timer = setTimeout(() => {
      if (!host2.isConnected || shows(host2)) return;
      const owner = this.owner(type) ?? type;
      if (!blindWarned.has(win.id)) {
        blindWarned.add(win.id);
        console.warn(`[tilr] ${owner}: window "${win.title}" (${type}) shows nothing to agents: add agent.text to its WindowType`);
      }
      counted = owner;
      plugins()?.blind(owner, 1);
      observer = new MutationObserver(() => {
        if (!shows(host2)) return;
        observer?.disconnect();
        uncount();
      });
      observer.observe(host2, { subtree: true, childList: true, characterData: true, attributes: true });
    }, BLIND_AFTER);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      uncount();
    };
  }
  get(type) {
    return this.state.types.get(type);
  }
  list() {
    return [...this.state.types.keys()];
  }
}
const overlays = /* @__PURE__ */ new Set();
const overlaySizes = new ResizeObserver(() => root.emit("ui/overlay"));
class UI extends Service {
  constructor(ctx) {
    super(ctx, "ui");
    this.windows = ctx.get("windows");
  }
  style(css) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    this.ctx.effect(() => adopt(document, sheet), "ui.style()");
  }
  overlay(element2) {
    let marked = false;
    const unmark = () => {
      if (!marked) return;
      marked = false;
      overlays.delete(element2);
      overlaySizes.unobserve(element2);
      root.emit("ui/overlay");
    };
    const dispose = this.ctx.effect(() => {
      marked = true;
      overlays.add(element2);
      overlaySizes.observe(element2);
      root.emit("ui/overlay");
      return unmark;
    }, "ui.overlay()");
    return () => {
      void dispose();
    };
  }
  overlays() {
    return [...overlays];
  }
  popup(element2, { anchor } = {}) {
    const listeners = /* @__PURE__ */ new Set();
    let opened = false;
    const set = (open) => {
      if (opened === open) return;
      opened = open;
      element2.hidden = !open;
      for (const listener of [...listeners]) listener(open);
    };
    element2.hidden = true;
    const outside = (event) => {
      const path = event.composedPath();
      if (!path.includes(element2) && !(anchor && path.includes(anchor))) set(false);
    };
    const escape = (event) => {
      if (opened && event.key === "Escape") set(false);
    };
    const blur = () => set(false);
    this.ctx.effect(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", escape, true);
      window.addEventListener("blur", blur);
      return () => {
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", escape, true);
        window.removeEventListener("blur", blur);
        set(false);
        listeners.clear();
      };
    }, "ui.popup()");
    this.overlay(element2);
    return {
      element: element2,
      get opened() {
        return opened;
      },
      open: () => set(true),
      close: () => set(false),
      toggle: () => set(!opened),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    };
  }
  /**
   * The tile is a `.tile` section (header, controls, body) the plugin owns. It is a window type
   * registered for this call alone (`<plugin>`, `<plugin>#2` …), opened on first use as a
   * singleton. Closing its window is remembered; reloading the plugin only remounts content.
   * Without a layout the tile is a plain grid cell.
   */
  tile({ title } = {}) {
    const ctx = this.ctx;
    const grid = document.getElementById("grid");
    const tile = element("section", FRAME.tile);
    const header = element("header", void 0, title ?? ctx.fiber.name);
    header.setAttribute(FRAME.drag, "");
    const controls = element("div", FRAME.controls);
    const body = element("div", FRAME.body);
    tile.append(header, controls, body);
    const host2 = ctx.root.get("plugins");
    const name = host2?.owner(ctx.fiber) ?? ctx.fiber.name;
    let type = name;
    for (let n = 2; this.windows.get(type); n++) type = `${name}#${n}`;
    tile.dataset.type = type;
    let disposed = false;
    const settle = () => queueMicrotask(() => {
      if (!disposed && !tile.isConnected && !ctx.root.get("layout")) grid.append(tile);
    });
    ctx.effect(() => {
      settle();
      return () => {
        disposed = true;
        tile.remove();
      };
    }, "ui.tile()");
    this.windows.add(ctx, type, {
      title: header.textContent,
      open: "once",
      singleton: true,
      mount(host3, win) {
        host3.append(tile);
        const undraw = drawControls(controls, win);
        return () => {
          undraw();
          tile.remove();
          settle();
        };
      }
    });
    return body;
  }
  snapshot(options = {}) {
    return agent.snapshot(options);
  }
  act(ref, action, value, options = {}) {
    return agent.act(ref, action, value, options);
  }
}
class PluginHost extends Service {
  constructor(ctx) {
    super(ctx, "plugins");
    this.scope = ctx;
    this.entries = /* @__PURE__ */ new Map();
    this.off = new Set(read());
    this.unnamed = /* @__PURE__ */ new Map();
    this.blinds = /* @__PURE__ */ new Map();
    ctx.on("internal/status", () => this.changed());
  }
  changed() {
    this.scope.emit("plugins/change");
  }
  /** The plugin in plugins.json that `fiber` belongs to: its own, or the one of an ancestor (a
   *  plugin's sub-plugin). null for the runtime's. */
  owner(fiber) {
    for (let f = fiber; f && f.uid !== null && f.uid !== 0; ) {
      const uid = f.uid;
      for (const entry of this.entries.values()) if (entry.fiber?.uid === uid) return entry.name;
      const up = f.parent?.fiber;
      if (up === f) break;
      f = up;
    }
    return null;
  }
  /** One more unnamed control in a window of `name`'s. */
  flag(name) {
    this.unnamed.set(name, (this.unnamed.get(name) ?? 0) + 1);
    this.changed();
  }
  /** One window more (`delta` 1) or less (-1) of `name`'s that shows an agent nothing. */
  blind(name, delta) {
    if (!this.entries.has(name)) return;
    this.blinds.set(name, Math.max(0, (this.blinds.get(name) ?? 0) + delta));
    this.changed();
  }
  /** Rows for the panel: state plus the plugin's metadata (author, tags, provide, inject). */
  list() {
    return [...this.entries.values()].map((entry) => {
      const plugin = entry.module?.default;
      return {
        name: entry.name,
        author: plugin?.author ?? null,
        tags: [...plugin?.tags ?? []],
        provides: plugin?.provide ?? null,
        injects: injects(plugin),
        enabled: !this.off.has(entry.name),
        locked: !!plugin?.locked,
        version: plugin?.version ?? null,
        api: plugin?.api ?? null,
        state: entry.incompatible ? "incompatible" : entry.error ? "failed" : entry.fiber ? STATE[entry.fiber.state] : "off",
        error: entry.error,
        loadedAt: entry.loadedAt,
        unnamed: this.unnamed.get(entry.name) ?? 0,
        blind: this.blinds.get(entry.name) ?? 0
      };
    });
  }
  /** Reads plugins.json and adds, removes and (re)starts plugins to match it. */
  async sync() {
    const response = await fetch(new URL("./plugins.json", import.meta.url), { cache: "no-store" });
    if (!response.ok) throw new Error(`plugins.json: ${response.status}`);
    const names = pluginNames(await response.json());
    if (this.entries.size === 0 && names.includes("performance") && !this.off.has("performance")) {
      bootPerformance();
      performanceCollector?.instrumentEvents(this.scope, (ctx) => this.owner(ctx.fiber) ?? ctx.fiber.name ?? "runtime");
    }
    const notes = [];
    for (const [name, entry] of [...this.entries]) {
      if (names.includes(name)) continue;
      await this.stop(entry);
      this.entries.delete(name);
      notes.push(`${name}: removed`);
    }
    for (const name of names) {
      if (this.entries.has(name)) continue;
      this.entries.set(name, { name, module: null, fiber: null, error: null, incompatible: false, loadedAt: null });
      notes.push(await this.reload(name));
    }
    this.changed();
    return notes.join(", ") || "plugins.json: no change";
  }
  /** Imports the plugin's file again and swaps the running instance for the new code. */
  async reload(name) {
    const entry = this.entries.get(name);
    if (!entry) return `${name}: not in plugins.json`;
    const collector = performanceCollector;
    const loadStarted = collector ? performance.now() : 0;
    const loadKind = entry.module ? "reload" : "load";
    let module;
    try {
      module = await import(new URL(`./plugins/${name}/index.js?v=${Date.now()}`, import.meta.url).href);
      if (!hasDefault(module)) throw new Error("the default export is not a plugin (a function, a class, or { apply })");
      stampBuild(module);
      collector?.event(loadKind, name, "Import module", performance.now() - loadStarted);
    } catch (error) {
      collector?.event("error", name, "Import failed", performance.now() - loadStarted);
      entry.error = asError(error);
      entry.incompatible = false;
      this.changed();
      return `${name}: import failed: ${entry.error.message}`;
    }
    await this.stop(entry);
    entry.module = module;
    entry.loadedAt = Date.now();
    await this.start(entry);
    if (collector) metric(`plugin.${loadKind}`, performance.now() - loadStarted, { plugin: name });
    return entry.incompatible ? `${name}: incompatible: ${entry.error?.message}` : `${name}: reloaded`;
  }
  /** The running plugin (one with a fiber) that provides `service`, other than `except`. */
  provider(service, except) {
    for (const other of this.entries.values()) {
      if (other !== except && other.fiber && other.module?.default?.provide === service) return other;
    }
  }
  /** Another running plugin that provides the same service (two themes at once). */
  rival(entry) {
    const provide = entry.module?.default?.provide;
    return provide ? this.provider(provide, entry) : void 0;
  }
  /** Why `plugin` cannot run on this page, or null: its `api` range against the page's API, each
   *  `requires` range against the version of the provider running now. A service nobody
   *  provides yet is not checked here; `revalidate` checks it when its provider starts. */
  incompatibility(plugin) {
    if (plugin.api !== void 0 && !satisfies("0.1.14", plugin.api)) return `needs tilr api ${plugin.api}, the page has ${"0.1.14"}`;
    for (const [service, range] of Object.entries(plugin.requires ?? {})) {
      const provider = this.provider(service);
      if (!provider || range === void 0) continue;
      const version = provider.module?.default?.version;
      if (version === void 0 || !satisfies(version, range)) return `needs ${service} ${range}, ${provider.name} is ${version ?? "unversioned"}`;
    }
    return null;
  }
  /** `entry`, a provider, just started: the plugins that require its service are checked
   *  against its version. A running one that no longer fits is stopped, an incompatible one
   *  gets another try (the provider may now be the right version). */
  async revalidate(entry) {
    const service = entry.module?.default?.provide;
    if (!service) return;
    for (const other of [...this.entries.values()]) {
      const plugin = other.module?.default;
      if (other === entry || !plugin || !Object.keys(plugin.requires ?? {}).includes(service)) continue;
      if (other.incompatible) await this.start(other);
      else if (other.fiber) {
        const reason = this.incompatibility(plugin);
        if (reason) await this.refuse(other, reason);
      }
    }
  }
  /** Stops `entry` (if it runs) and marks it incompatible for `reason`. */
  async refuse(entry, reason) {
    await this.stop(entry);
    entry.error = new Error(reason);
    entry.incompatible = true;
    this.changed();
  }
  async start(entry) {
    if (this.off.has(entry.name) || entry.fiber || !entry.module) return;
    if (this.rival(entry)) {
      this.off.add(entry.name);
      write([...this.off]);
      this.changed();
      return;
    }
    const plugin = entry.module.default;
    const reason = this.incompatibility(plugin);
    if (reason) return this.refuse(entry, reason);
    entry.error = null;
    entry.incompatible = false;
    this.unnamed.delete(entry.name);
    const started = performanceCollector ? performance.now() : 0;
    try {
      entry.fiber = this.scope.plugin(plugin);
    } catch (error) {
      entry.error = asError(error);
      this.changed();
      return;
    }
    entry.fiber.await().then(() => {
      measure(`plugin:start ${entry.name}`, started);
      if (started) metric("plugin.start", performance.now() - started, { plugin: entry.name });
    }, (error) => {
      entry.error = asError(error);
      this.changed();
    });
    this.changed();
    await this.revalidate(entry);
  }
  async stop(entry) {
    const fiber = entry.fiber;
    entry.fiber = null;
    entry.error = null;
    entry.incompatible = false;
    if (fiber) {
      mark(`plugin:dispose ${entry.name}`);
      await fiber.dispose();
    }
    this.changed();
  }
  async toggle(name) {
    const entry = this.entries.get(name);
    if (!entry || entry.module?.default?.locked) return;
    if (this.off.delete(name)) {
      const rival = this.rival(entry);
      if (rival) {
        this.off.add(rival.name);
        await this.stop(rival);
      }
      if (entry.module) await this.start(entry);
      else await this.reload(name);
    } else {
      this.off.add(name);
      await this.stop(entry);
    }
    write([...this.off]);
  }
}
function read() {
  try {
    const names = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return Array.isArray(names) ? names.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}
function write(names) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
  }
}
await root.plugin(Windows);
await root.plugin(UI);
await root.plugin(PluginHost);
const host = root.get("plugins");
const CORE = ["ui", "plugins", "windows"];
function frames() {
  const layout = root.get("layout");
  if (layout) {
    const windows = root.get("windows");
    return layout.list().map((row) => {
      const mounted = windows.mounted(row.id);
      const agent2 = mounted && mounted.type === row.type ? windows.get(row.type)?.agent : void 0;
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        mode: row.mode,
        focused: row.focused,
        ...row.parent ? { parent: row.parent } : {},
        host: document.querySelector(`.window[data-window="${CSS.escape(row.id)}"]`),
        ...mounted ? { content: mounted.host, handle: mounted.win } : {},
        ...agent2 ? { agent: agent2 } : {}
      };
    });
  }
  return Array.from(document.querySelectorAll("#grid > .tile[data-type]"), (tile) => {
    const type = tile.dataset.type ?? "";
    return { id: type, type, title: tile.querySelector("header")?.textContent ?? type, mode: "tile", focused: false, host: tile };
  });
}
function ownerOf(el) {
  const win = closest(el, ".window[data-window]");
  const tile = win ? null : closest(el, ".tile[data-type]");
  const type = win?.getAttribute("data-type") ?? tile?.getAttribute("data-type");
  if (!type) return null;
  const windows = root.get("windows");
  return { window: win?.getAttribute("data-window") ?? type, plugin: windows.owner(type) ?? type };
}
const agent = new Agent(frames, ownerOf);
agent.watch((owner, el) => {
  console.warn(`[tilr] ${owner.plugin}: unnamed ${describeElement(el)} in window ${owner.window}: give it text, aria-label or a <label>`);
  if (host.entries.has(owner.plugin)) host.flag(owner.plugin);
});
function running() {
  const names = new Set(CORE);
  for (const entry of host.entries.values()) {
    const provide = entry.fiber ? entry.module?.default?.provide : void 0;
    if (provide && root.get(provide) != null) names.add(provide);
  }
  return [...names];
}
async function declarations(path) {
  try {
    const response = await fetch(new URL(path, import.meta.url), { cache: "no-store" });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}
function pageServices(api) {
  const start = api.indexOf("export interface TilrServices {");
  if (start === -1) return [];
  const body = api.slice(start, api.indexOf("\n}", start));
  return [...body.matchAll(/^\s+(\w+): /gm)].map((match) => match[1]);
}
async function describe(service) {
  const names = service === void 0 ? running() : [service];
  const texts = /* @__PURE__ */ new Map();
  const load = (path) => {
    let text = texts.get(path);
    if (!text) texts.set(path, text = declarations(path));
    return text;
  };
  return Promise.all(names.map(async (name) => {
    const target = root.get(name);
    if (target == null) throw new Error(`no service "${name}" is running`);
    const core = CORE.includes(name);
    const provider = core ? void 0 : host.provider(name);
    const plugin = core ? "runtime" : provider?.name ?? null;
    const version = core ? "0.1.14" : provider?.module?.default?.version ?? null;
    const page = await load("./api.d.ts");
    let api = null;
    if (page && (core || pageServices(page).includes(name))) api = page;
    else if (plugin && !core) api = await load(`./plugins/${plugin}/api.d.ts`);
    const contract = api === null ? null : contractOf(api, name);
    return {
      name,
      plugin,
      version,
      ...members(target, Service.prototype, contract),
      // A service with a `Service.invoke` body is a function: `$.open(target)`.
      ...typeof target === "function" ? { callable: true } : {},
      api: service === void 0 ? null : api
    };
  }));
}
window.tilr = {
  root,
  api: "0.1.14",
  react: reactMode,
  services: serviceProxy((name) => root.get(name) ?? void 0, running),
  describe,
  hmr: {
    async changed(paths) {
      const names = /* @__PURE__ */ new Set();
      let manifest = false;
      for (const path of paths) {
        if (path === "plugins.json") manifest = true;
        const match = /^plugins\/([^/]+)\//.exec(path);
        if (match) names.add(match[1]);
      }
      const notes = [];
      const started = Date.now();
      if (manifest) notes.push(await host.sync());
      for (const name of names) {
        if ((host.entries.get(name)?.loadedAt ?? 0) >= started) continue;
        notes.push(await host.reload(name));
      }
      return notes.join("; ");
    }
  }
};
console.log(await host.sync());
mark("page:ready");
//# sourceMappingURL=runtime.js.map
