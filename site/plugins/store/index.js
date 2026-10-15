import { Service } from "cordis";
const PREFIX = "tilr.";
const LEGACY = {
  "tilr-layout": { area: "layout", key: "data" },
  "tilr-panel": { area: "panel", key: "state" },
  "tilr-clock-zone": { area: "header", key: "zone" }
};
class LocalBackend {
  name = "local";
  storage;
  events;
  constructor(storage, events) {
    this.storage = storage;
    this.events = events;
  }
  load(area) {
    const out = /* @__PURE__ */ new Map();
    const storage = this.storage;
    if (!storage) return out;
    try {
      this.migrate(area);
      const prefix = `${PREFIX}${area}.`;
      for (let i = 0; i < storage.length; i += 1) {
        const name = storage.key(i);
        if (name === null || !name.startsWith(prefix)) continue;
        const text = storage.getItem(name);
        if (text !== null) out.set(name.slice(prefix.length), text);
      }
    } catch {
    }
    return out;
  }
  areas() {
    const out = /* @__PURE__ */ new Set();
    const storage = this.storage;
    if (!storage) return [];
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const name = storage.key(i);
        const parsed = name === null ? null : parse(name);
        if (parsed) out.add(parsed.area);
      }
      for (const [old, to] of Object.entries(LEGACY)) if (storage.getItem(old) !== null) out.add(to.area);
    } catch {
    }
    return [...out].sort();
  }
  write(area, key, text) {
    if (!this.storage) return false;
    try {
      if (text === null) this.storage.removeItem(`${PREFIX}${area}.${key}`);
      else this.storage.setItem(`${PREFIX}${area}.${key}`, text);
      return true;
    } catch {
      return false;
    }
  }
  listen(on) {
    const events = this.events;
    if (!events) return () => {
    };
    const listener = (event) => {
      const { key: name, newValue } = event;
      if (name === null) return on(null);
      const change = parse(name);
      if (change) on({ ...change, text: newValue });
    };
    events.addEventListener("storage", listener);
    return () => events.removeEventListener("storage", listener);
  }
  /** The area's old keys (LEGACY), moved to its own unless it has them already. A value that is
   *  not JSON stays where it was. */
  migrate(area) {
    const storage = this.storage;
    if (!storage) return;
    for (const [old, to] of Object.entries(LEGACY)) {
      if (to.area !== area) continue;
      const text = storage.getItem(old);
      if (text === null) continue;
      const name = `${PREFIX}${area}.${to.key}`;
      if (storage.getItem(name) === null) {
        try {
          JSON.parse(text);
        } catch {
          continue;
        }
        storage.setItem(name, text);
      }
      storage.removeItem(old);
    }
  }
}
function parse(name) {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return { area: rest.slice(0, dot), key: rest.slice(dot + 1) };
}
class Area {
  name;
  secure;
  entries;
  watchers = /* @__PURE__ */ new Set();
  /** A failed write was warned about. */
  warned = false;
  constructor(name, secure, texts) {
    this.name = name;
    this.secure = secure;
    this.entries = /* @__PURE__ */ new Map();
    for (const [key, text] of texts) {
      try {
        this.entries.set(key, { value: JSON.parse(text), text });
      } catch {
      }
    }
  }
}
class Cache {
  backend;
  areas = /* @__PURE__ */ new Map();
  emit;
  constructor(backend, emit = () => {
  }) {
    this.backend = backend;
    this.emit = emit;
  }
  /** The area, loaded on its first call. A later `secure` makes it secure (never the reverse). */
  open(name, secure = false) {
    if (typeof name !== "string" || !name || name.includes(".")) throw new Error(`store: bad area name '${String(name)}' (non-empty, no dots)`);
    let area = this.areas.get(name);
    if (!area) this.areas.set(name, area = new Area(name, secure, this.backend.load(name, secure)));
    else if (secure) area.secure = true;
    return area;
  }
  get(area, key) {
    return area.entries.get(String(key))?.value;
  }
  set(area, key, value) {
    key = String(key);
    const text = JSON.stringify(value);
    if (text === void 0) return this.delete(area, key);
    if (area.entries.get(key)?.text === text) return;
    area.entries.set(key, { value: JSON.parse(text), text });
    this.through(area, key, text);
    this.changed(area, key);
  }
  delete(area, key) {
    key = String(key);
    if (!area.entries.has(key)) return;
    area.entries.delete(key);
    this.through(area, key, null);
    this.changed(area, key);
  }
  keys(area) {
    return [...area.entries.keys()];
  }
  watch(area, key, listener) {
    const watcher = { key: key === null ? null : String(key), listener };
    area.watchers.add(watcher);
    return () => {
      area.watchers.delete(watcher);
    };
  }
  /** A change from elsewhere (the backend's `listen`). An area not loaded here is nobody's
   *  concern: it is read fresh when opened. */
  receive(change) {
    if (change === null) {
      for (const area2 of this.areas.values()) this.reload(area2);
      return;
    }
    const area = this.areas.get(change.area);
    if (!area) return;
    const entry = area.entries.get(change.key);
    if (change.text === null) {
      if (!entry) return;
      area.entries.delete(change.key);
    } else {
      if (entry?.text === change.text) return;
      let value;
      try {
        value = JSON.parse(change.text);
      } catch {
        return;
      }
      area.entries.set(change.key, { value, text: change.text });
    }
    this.changed(area, change.key);
  }
  /** Every area the backend has, and every area opened here: key → value. An opened area is
   *  as the cache has it (a write the backend refused included); an empty one is left out. */
  dump() {
    const out = {};
    for (const name of [.../* @__PURE__ */ new Set([...this.backend.areas(), ...this.areas.keys()])].sort()) {
      const values = {};
      const area = this.areas.get(name);
      if (area) for (const [key, entry] of area.entries) values[key] = entry.value;
      else {
        for (const [key, text] of this.backend.load(name, false)) {
          try {
            values[key] = JSON.parse(text);
          } catch {
          }
        }
      }
      if (Object.keys(values).length) out[name] = values;
    }
    return out;
  }
  /** Forgets the watchers (the service is going; the plugins that added them go with it). */
  clear() {
    for (const area of this.areas.values()) area.watchers.clear();
  }
  reload(area) {
    const fresh = new Area(area.name, area.secure, this.backend.load(area.name, area.secure));
    const before = area.entries;
    area.entries = fresh.entries;
    for (const key of /* @__PURE__ */ new Set([...before.keys(), ...fresh.entries.keys()])) {
      if (before.get(key)?.text !== fresh.entries.get(key)?.text) this.changed(area, key);
    }
  }
  through(area, key, text) {
    if (this.backend.write(area.name, key, text, area.secure) || area.warned) return;
    area.warned = true;
    console.warn(`store: the ${this.backend.name} backend refused a write to '${area.name}' (kept for this page only)`);
  }
  changed(area, key) {
    const value = area.entries.get(key)?.value;
    for (const watcher of [...area.watchers]) {
      if (watcher.key !== null && watcher.key !== key) continue;
      try {
        watcher.listener(key, value);
      } catch (error) {
        console.error(error);
      }
    }
    this.emit(area.name, key, value);
  }
}
async function seed(backend, manifest, fetcher = globalThis.fetch) {
  if (backend.areas().length) return null;
  let data;
  try {
    const list = await fetcher(manifest, { cache: "no-store" });
    if (!list.ok) return null;
    const { store } = await list.json();
    if (typeof store !== "string" || !store) return null;
    const response = await fetcher(new URL(store, list.url || manifest), { cache: "no-store" });
    if (!response.ok) return null;
    data = await response.json();
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  let n = 0;
  for (const [area, values] of Object.entries(data)) {
    if (!area || area.includes(".") || !values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      const text = JSON.stringify(value);
      if (!key || text === void 0) continue;
      if (backend.write(area, key, text, false)) n += 1;
    }
  }
  return n;
}
class Handle {
  cache;
  area;
  ctx;
  constructor(cache, area, ctx) {
    this.cache = cache;
    this.area = area;
    this.ctx = ctx;
  }
  get name() {
    return this.area.name;
  }
  get(key) {
    return this.cache.get(this.area, key);
  }
  set(key, value) {
    this.cache.set(this.area, key, value);
  }
  delete(key) {
    this.cache.delete(this.area, key);
  }
  keys() {
    return this.cache.keys(this.area);
  }
  watch(key, listener) {
    const off = this.cache.watch(this.area, key, listener);
    if (!this.ctx) return off;
    try {
      const dispose = this.ctx.effect(() => off, `store: watch('${this.area.name}')`);
      return () => {
        void dispose();
      };
    } catch {
      return off;
    }
  }
}
function local() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
class StoreService extends Service {
  static provide = "store";
  static author = "dan";
  static tags = ["core"];
  static version = "0.1.14";
  // Layout, the panel and the header keep their state here: switching it off would take them along.
  static locked = true;
  constructor(ctx) {
    super(ctx, StoreService.provide);
    const cache = new Cache(new LocalBackend(local(), globalThis.window ?? null), (area, key, value) => ctx.emit("store/change", area, key, value));
    this.state = { cache };
    ctx.effect(() => {
      const off = cache.backend.listen((change) => cache.receive(change));
      return () => {
        off();
        cache.clear();
      };
    }, "store: changes from elsewhere");
  }
  /** A fresh page is seeded from the file plugins.json names (site/plugins/store/index.js →
   *  site/plugins.json) before anyone injecting 'store' starts. */
  async [Service.init]() {
    const n = await seed(this.state.cache.backend, new URL("../../plugins.json", import.meta.url));
    if (n !== null) console.info(`store: seeded ${n} keys from the site's seed`);
  }
  get backend() {
    return this.state.cache.backend.name;
  }
  area(name, options) {
    return new Handle(this.state.cache, this.state.cache.open(name, options?.secure === true), this.ctx);
  }
  dump() {
    return this.state.cache.dump();
  }
}
var store_default = StoreService;
export {
  Cache,
  LEGACY,
  LocalBackend,
  PREFIX,
  store_default as default,
  parse,
  seed
};
//# sourceMappingURL=index.js.map
