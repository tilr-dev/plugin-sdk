import { Service } from "cordis";
const AREA = "open";
function check(target) {
  const t = target;
  if (!t || typeof t !== "object" || typeof t.kind !== "string" || !t.kind) throw new Error("open: a target is { kind, … }");
  if (t.kind === "file" && (typeof t.server !== "string" || typeof t.path !== "string" || !t.path)) throw new Error("open: a file target needs `server` and `path` (strings)");
  if (t.kind === "url" && (typeof t.url !== "string" || !t.url)) throw new Error("open: a url target needs `url` (a string)");
  return t;
}
function basename(path) {
  return path.replace(/\/+$/, "").split("/").pop() ?? "";
}
function extension(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}
function keyOf(target) {
  if (target.kind === "file") return `file:${extension(target.path)}`;
  if (target.kind === "url") {
    try {
      return `url:${new URL(target.url).hostname.toLowerCase()}`;
    } catch {
      return "url:";
    }
  }
  return `${target.kind}:*`;
}
function describeKey(key) {
  const [kind, rest] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (kind === "file") return rest ? `${rest} files` : "files without an extension";
  if (kind === "url") return rest || "web addresses";
  return kind;
}
class Registry {
  handlers = /* @__PURE__ */ new Map();
  store;
  constructor(store) {
    this.store = store;
  }
  add(handler) {
    if (this.handlers.has(handler.id)) throw new Error(`open: a handler "${handler.id}" is already registered`);
    this.handlers.set(handler.id, handler);
    return () => {
      if (this.handlers.get(handler.id) === handler) this.handlers.delete(handler.id);
    };
  }
  /** Every handler, in registration order. */
  all() {
    return [...this.handlers.values()];
  }
  /** The handlers that match `target` (score > 0), best first, registration order among equals.
   *  A throwing `match` counts as 0 (and is logged). */
  candidates(target) {
    const out = [];
    for (const handler of this.handlers.values()) {
      let score = 0;
      try {
        score = Number(handler.match(target)) || 0;
      } catch (error) {
        console.error(`[open] ${handler.id}: match threw`, error);
      }
      if (score > 0) out.push({ handler, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }
  /** The handler `name` stands for: an id, else the first of that plugin. */
  find(name) {
    return this.handlers.get(name) ?? this.all().find((handler) => handler.plugin === name);
  }
  /** The remembered choice for `target`'s key. */
  remembered(target) {
    const id = this.store.get(keyOf(target));
    return typeof id === "string" ? id : void 0;
  }
  /** The handler to open `target` with, or null for none (nothing matches, a choice dismissed). */
  async choose(target, options, ask) {
    if (options.handler !== void 0) {
      const handler = this.find(options.handler);
      if (!handler) throw new Error(`open: no handler "${options.handler}" (open.handlers() lists them)`);
      return handler;
    }
    const candidates = this.candidates(target).map((c) => c.handler);
    if (!candidates.length) return null;
    if (!options.ask) {
      if (candidates.length === 1) return candidates[0];
      const remembered = this.remembered(target);
      const handler = candidates.find((h) => h.id === remembered);
      if (handler) return handler;
    }
    const key = keyOf(target);
    const picked = await ask(candidates, key);
    if (!picked) return null;
    if (picked.remember) this.store.set(key, picked.handler.id);
    return picked.handler;
  }
  defaults() {
    const out = {};
    for (const key of this.store.keys()) {
      const id = this.store.get(key);
      if (typeof id === "string") out[key] = id;
    }
    return out;
  }
  forget(key) {
    if (key === void 0) for (const k of this.store.keys()) this.store.delete(k);
    else this.store.delete(typeof key === "string" ? key : keyOf(check(key)));
  }
}
const css = `
  .tilr-open-with {
    position: fixed; z-index: 2147483646; top: 22%; left: 50%; transform: translateX(-50%);
    min-width: 260px; max-width: 420px; padding: 8px; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 2px;
    font: var(--font); color: var(--text);
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  }
  .tilr-open-with[hidden] { display: none; }
  .tilr-open-with h2 {
    margin: 0 0 6px; padding: 0 6px; font: inherit; font-weight: bold; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tilr-open-with button {
    display: flex; justify-content: space-between; gap: 16px; padding: 5px 6px;
    font: inherit; color: inherit; text-align: left; background: none; border: 0; border-radius: var(--radius);
    cursor: pointer;
  }
  .tilr-open-with button:hover, .tilr-open-with button:focus-visible { background: var(--line); color: var(--accent); outline: none; }
  .tilr-open-with button span { color: var(--muted); }
  .tilr-open-with label { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding: 0 6px; color: var(--muted); }
`;
class OpenService extends Service {
  static provide = "open";
  static author = "dan";
  static tags = ["core"];
  static version = "0.1.14";
  // ui: the "Open with…" popup; store: the remembered choices.
  static inject = ["ui", "store"];
  // Plugins register their handlers here: switching it off would take every "open" along.
  static locked = true;
  constructor(ctx) {
    super(ctx, OpenService.provide);
    const area = ctx.store.area(AREA);
    ctx.ui.style(css);
    const element = document.createElement("div");
    element.className = "tilr-open-with";
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-label", "Open with");
    ctx.effect(() => {
      document.body.append(element);
      return () => element.remove();
    }, "open: the popup");
    const popup = ctx.ui.popup(element);
    this.state = { registry: new Registry(area), popup, pending: null };
    popup.subscribe((opened) => {
      if (!opened) this.settle(null);
    });
  }
  /** `ctx.open(target, options)`. `this.ctx` is the caller's: the default `from` is its plugin. */
  async [Service.invoke](target, options = {}) {
    check(target);
    const handler = await this.state.registry.choose(target, options ?? {}, (candidates, key) => this.ask(target, candidates, key));
    if (!handler) return void 0;
    const from = options?.from ?? { plugin: this.caller(), window: null };
    const id = await handler.open(target, from);
    return typeof id === "string" ? id : void 0;
  }
  register(handler) {
    if (!handler || typeof handler.name !== "string" || !handler.name || typeof handler.match !== "function" || typeof handler.open !== "function") {
      throw new Error("open.register: { name, match(target), open(target, from) }");
    }
    const plugin = handler.plugin ?? this.caller();
    const entry = { ...handler, plugin, id: `${plugin}/${handler.name}` };
    let remove = null;
    const dispose = this.ctx.effect(() => {
      remove = this.state.registry.add(entry);
      return () => remove?.();
    }, `open.register(${entry.id})`);
    return () => {
      void dispose();
    };
  }
  handlers(target) {
    const { registry } = this.state;
    if (target === void 0) return registry.all().map((h) => ({ id: h.id, plugin: h.plugin, name: h.name }));
    check(target);
    const remembered = registry.remembered(target);
    return registry.candidates(target).map(({ handler: h, score }) => ({
      id: h.id,
      plugin: h.plugin,
      name: h.name,
      score,
      ...h.id === remembered ? { default: true } : {}
    }));
  }
  defaults() {
    return this.state.registry.defaults();
  }
  forget(key) {
    this.state.registry.forget(key);
  }
  /** The calling plugin's name in plugins.json (its fiber's name outside them). */
  caller() {
    const host = this.ctx.root.get("plugins");
    return host?.owner?.(this.ctx.fiber) ?? (this.ctx.fiber.name || "tilr");
  }
  /** Shows "Open with…" for `candidates`; resolves to the pick, or null when dismissed (or
   *  another ask took the popup over). */
  ask(target, candidates, key) {
    this.settle(null);
    const { popup } = this.state;
    const element = popup.element;
    const what = target.kind === "file" ? basename(target.path) : target.kind === "url" ? target.url : target.kind;
    const title = document.createElement("h2");
    title.textContent = `Open ${what} with…`;
    const remember = document.createElement("input");
    remember.type = "checkbox";
    remember.checked = true;
    const label = document.createElement("label");
    label.append(remember, `Always use it for ${describeKey(key)}`);
    const buttons = candidates.map((handler) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.call = "open";
      button.dataset.handler = handler.id;
      button.setAttribute("aria-label", `Open with ${handler.name}`);
      const name = document.createElement("b");
      name.textContent = handler.name;
      const plugin = document.createElement("span");
      plugin.textContent = handler.plugin;
      button.append(name, plugin);
      button.addEventListener("click", () => this.settle({ handler, remember: remember.checked }));
      return button;
    });
    element.onkeydown = (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const at = buttons.indexOf(document.activeElement);
      const next = (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    element.replaceChildren(title, ...buttons, label);
    return new Promise((resolve) => {
      this.state.pending = resolve;
      popup.open();
      buttons[0]?.focus();
    });
  }
  /** Ends the pending ask with `picked` and closes the popup. */
  settle(picked) {
    const resolve = this.state.pending;
    this.state.pending = null;
    resolve?.(picked);
    this.state.popup.close();
  }
}
var open_default = OpenService;
export {
  AREA,
  Registry,
  basename,
  check,
  open_default as default,
  describeKey,
  extension,
  keyOf
};
//# sourceMappingURL=index.js.map
