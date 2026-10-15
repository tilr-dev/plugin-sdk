const CLIP = 80;
const CONTROLS = /* @__PURE__ */ new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "textbox",
  "searchbox",
  "combobox",
  "slider",
  "spinbutton",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "focusable"
]);
const NAMED_BY_CONTENT = /* @__PURE__ */ new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "heading",
  "cell",
  "columnheader",
  "rowheader",
  "tooltip"
]);
const TEXTUAL = /* @__PURE__ */ new Set(["heading", "status", "alert", "log", "tooltip", "img", "math"]);
const CHECKABLE = /* @__PURE__ */ new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const MEDIA = /* @__PURE__ */ new Set(["SVG", "CANVAS", "VIDEO", "AUDIO"]);
const SKIP = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "DATALIST", "IFRAME", "OPTION", "OPTGROUP", "HEAD", "META", "LINK"]);
const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable]:not([contenteditable=false])",
  '[tabindex]:not([tabindex^="-"])',
  ...[...CONTROLS].filter((role) => role !== "focusable").map((role) => `[role=${role}]`)
].join(", ");
const normalize = (text) => text.replace(/\s+/g, " ").trim();
const clip = (text, max = CLIP) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const tag = (el) => el.tagName.toUpperCase();
const attr = (el, name) => el.getAttribute(name);
function ownText(node) {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out += child.textContent ?? "";
    else if (child.nodeType === 1) {
      const el = child;
      if (["SELECT", "TEXTAREA", "INPUT", "SCRIPT", "STYLE", "TEMPLATE", "DATALIST"].includes(tag(el))) continue;
      if (attr(el, "aria-hidden") === "true") continue;
      out += ` ${ownText(el)} `;
    }
  }
  return normalize(out);
}
function roleOf(el) {
  const explicit = attr(el, "role")?.trim().split(/\s+/)[0];
  const name = tag(el);
  if (explicit === "presentation" || explicit === "none") {
    if (!["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(name)) return null;
  } else if (explicit) return explicit;
  switch (name) {
    case "BUTTON":
    case "SUMMARY":
      return "button";
    case "A":
      if (el.hasAttribute("href")) return "link";
      break;
    case "SELECT":
      return el.hasAttribute("multiple") || Number(attr(el, "size") ?? 0) > 1 ? "listbox" : "combobox";
    case "TEXTAREA":
      return "textbox";
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return "heading";
    case "LI":
      return "listitem";
    case "OUTPUT":
      return "status";
    case "IMG":
      return "img";
    case "FIELDSET":
      return "group";
    case "DIALOG":
      return "dialog";
    case "PROGRESS":
      return "progressbar";
    case "INPUT": {
      const type = (attr(el, "type") ?? "").toLowerCase();
      if (type === "hidden") return null;
      if (type === "checkbox") return el.hasAttribute("switch") ? "switch" : "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
      if (type === "file" || type === "color") return "button";
      return "textbox";
    }
  }
  const editable = attr(el, "contenteditable");
  if (editable !== null && editable !== "false") return "textbox";
  const tabindex = attr(el, "tabindex");
  if (tabindex !== null && Number(tabindex) >= 0) return "focusable";
  if (explicit || name === "INPUT" || MEDIA.has(name) || attr(el, "aria-hidden") === "true") return null;
  if (normalize(attr(el, "aria-label") ?? "") || normalize(attr(el, "title") ?? "")) return "generic";
  return null;
}
const isField = (el) => ["INPUT", "SELECT", "TEXTAREA"].includes(tag(el)) || attr(el, "contenteditable") !== null && attr(el, "contenteditable") !== "false";
function accessibleName(el) {
  const label = normalize(attr(el, "aria-label") ?? "");
  if (label) return clip(label);
  const by = attr(el, "aria-labelledby");
  if (by) {
    const doc = el.ownerDocument;
    const text = normalize(by.split(/\s+/).map((id) => {
      const ref = doc?.getElementById(id);
      return ref ? ownText(ref) : "";
    }).join(" "));
    if (text) return clip(text);
  }
  const labels = el.labels;
  if (labels && labels.length) {
    const text = normalize(Array.from(labels).map(ownText).join(" "));
    if (text) return clip(text);
  }
  const role = roleOf(el);
  if (!isField(el) && (role === null || NAMED_BY_CONTENT.has(role) || TEXTUAL.has(role))) {
    const text = ownText(el);
    if (text) return clip(text);
  }
  if (tag(el) === "INPUT" && ["button", "submit", "reset"].includes((attr(el, "type") ?? "").toLowerCase())) {
    const value = normalize(el.value ?? attr(el, "value") ?? "");
    if (value) return clip(value);
  }
  if (tag(el) === "IMG" || tag(el) === "AREA") {
    const alt = normalize(attr(el, "alt") ?? "");
    if (alt) return clip(alt);
  }
  for (const name of ["placeholder", "title"]) {
    const text = normalize(attr(el, name) ?? "");
    if (text) return clip(text);
  }
  return "";
}
const isControl = (role) => CONTROLS.has(role);
const quote = (text) => JSON.stringify(text);
function line(node, depth) {
  let out = `${"  ".repeat(depth)}${node.role}`;
  const control = isControl(node.role);
  if (node.name || control) out += ` ${quote(node.name)}`;
  if (node.value !== void 0) out += ` = ${quote(node.value)}`;
  if (node.state?.length) out += ` [${node.state.join(", ")}]`;
  if (node.ref) out += ` [${node.ref}]`;
  if (node.call) out += ` → ${node.call}`;
  if (control && !node.name) out += " (unnamed)";
  if (node.text !== void 0) out += node.text ? " =" : ' = ""';
  return out;
}
function formatSnapshot(windows) {
  if (!windows.length) return "no windows";
  const out = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      out.push(line(node, depth));
      if (node.text) for (const text of node.text.split("\n")) out.push(`${"  ".repeat(depth + 1)}| ${text}`.trimEnd());
      if (node.children) walk(node.children, depth + 1);
    }
  };
  for (const win of windows) {
    const marks = [win.type, win.mode, win.focused && "focused", win.parent && `in ${win.parent}`, win.hidden && "hidden", win.closed && "closed"].filter(Boolean);
    out.push(`window ${win.id} ${quote(win.title)} (${marks.join(", ")})`);
    walk(win.nodes, 1);
    if (win.timedOut !== void 0) out.push(`(wait: timed out after ${win.timedOut} ms)`);
  }
  return out.join("\n");
}
const LINES = 40;
function trimLines(text) {
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}
function tail(text, lines = LINES) {
  const trimmed = trimLines(text);
  if (!trimmed) return "";
  const all = trimmed.split("\n").map((row) => row.trimEnd());
  const keep = Math.max(0, Math.floor(lines));
  if (all.length <= keep) return all.join("\n");
  const more = all.length - keep;
  return [`… (${more} more line${more === 1 ? "" : "s"})`, ...keep ? all.slice(-keep) : []].join("\n");
}
function documentNode(ref, title, type, adapter, win, lines, actionRef) {
  const node = { ref, role: "document", name: clip(normalize(title)) };
  if (adapter.text) {
    try {
      node.text = tail(String(adapter.text(win) ?? ""), lines);
    } catch (error) {
      node.text = `(agent.text failed: ${error instanceof Error ? error.message : String(error)})`;
    }
  }
  const actions = Object.keys(adapter.actions ?? {});
  if (actions.length) node.children = actions.map((name) => ({ ref: actionRef(name), role: "button", name, call: `${type}.${name}` }));
  return node;
}
function waitOptions(wait) {
  const number = (value, fallback, what) => {
    if (value === void 0) return fallback;
    if (typeof value !== "number" || !(value >= 0)) throw new Error(`wait.${what}: a number of milliseconds, not ${JSON.stringify(value)}`);
    return value;
  };
  let until;
  if (wait.until !== void 0 && wait.until !== "") {
    try {
      until = new RegExp(wait.until, "m");
    } catch (error) {
      throw new Error(`wait.until: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return { ...until ? { until } : {}, idleMs: number(wait.idleMs, 300, "idleMs"), timeoutMs: number(wait.timeoutMs, 1e4, "timeoutMs") };
}
function matchesText(until, text) {
  until.lastIndex = 0;
  return until.test(trimLines(text).split("\n").map((row) => row.trimEnd()).join("\n"));
}
const POLL = 100;
function waitFor(target, { until, idleMs, timeoutMs }) {
  return new Promise((resolve) => {
    let idle;
    let stop = () => {
    };
    const read = () => {
      try {
        return target.text();
      } catch {
        return "";
      }
    };
    let last = read();
    const poll = setInterval(() => {
      const now = read();
      if (now !== last) changed();
    }, POLL);
    const done = (ok) => {
      clearTimeout(idle);
      clearTimeout(deadline);
      clearInterval(poll);
      stop();
      resolve(ok);
    };
    const matches = () => until ? matchesText(until, last) : false;
    function changed() {
      last = read();
      if (matches()) return done(true);
      if (until) return;
      clearTimeout(idle);
      idle = setTimeout(() => done(true), idleMs);
    }
    const deadline = setTimeout(() => done(false), timeoutMs);
    stop = target.observe(changed);
    changed();
  });
}
const MODIFIERS = {
  meta: "metaKey",
  cmd: "metaKey",
  command: "metaKey",
  control: "ctrlKey",
  ctrl: "ctrlKey",
  alt: "altKey",
  option: "altKey",
  shift: "shiftKey"
};
const CODES = { " ": "Space", "-": "Minus", "=": "Equal", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "`": "Backquote" };
function parseKey(spec) {
  if (typeof spec !== "string" || !spec) throw new Error("press: which key? (Enter, Escape, a, Meta+k …)");
  const parts = spec.endsWith("++") ? [...spec.slice(0, -2).split("+"), "+"] : spec === "+" ? ["+"] : spec.split("+");
  let key = parts.pop() ?? "";
  const out = { key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  for (const part of parts) {
    const flag = MODIFIERS[part.toLowerCase()];
    if (!flag) throw new Error(`press: unknown modifier "${part}" in "${spec}" (Meta, Control, Alt, Shift)`);
    out[flag] = true;
  }
  if (!key) throw new Error(`press: no key in "${spec}"`);
  if (key === "Space") key = " ";
  if (key.length === 1) {
    const letter = /[a-z]/i.test(key);
    if (letter && out.shiftKey) key = key.toUpperCase();
    out.code = letter ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : CODES[key] ?? "";
  } else {
    key = key[0].toUpperCase() + key.slice(1);
    out.code = key;
  }
  out.key = key;
  return out;
}
const PROBES = /* @__PURE__ */ new Set(["then", "toJSON", "constructor", "valueOf", "toString", "inspect", "asymmetricMatch", "$$typeof"]);
function serviceProxy(get, names) {
  return new Proxy({}, {
    get(_, name) {
      if (typeof name !== "string" || PROBES.has(name)) return void 0;
      const service = get(name);
      if (service === void 0 || service === null) throw new Error(`no service "${name}" is running`);
      return service;
    },
    has: (_, name) => typeof name === "string" && get(name) != null,
    ownKeys: () => names(),
    getOwnPropertyDescriptor: (_, name) => typeof name === "string" && names().includes(name) ? { enumerable: true, configurable: true, value: get(name) } : void 0
  });
}
const PLUMBING = /* @__PURE__ */ new Set(["constructor", "ctx", "fiber", "config", "name", "scope", "length", "prototype"]);
function members(service, base, contract = null) {
  const methods = [];
  const fields = [];
  const seen = /* @__PURE__ */ new Set();
  const mark = (name) => contract && !contract.has(name) ? { internal: true } : {};
  for (let o = service; o && o !== base && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (seen.has(key) || key.startsWith("_") || PLUMBING.has(key)) continue;
      seen.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(o, key);
      if (!descriptor) continue;
      if (!descriptor.get && typeof descriptor.value === "function") methods.push({ name: key, arity: descriptor.value.length, ...mark(key) });
      else fields.push({ name: key, ...mark(key) });
    }
  }
  return { methods, fields };
}
function uncomment(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else out += c;
  }
  return out;
}
function interfaces(text, name) {
  const found = [];
  for (const match of text.matchAll(new RegExp(`\\binterface\\s+${name}\\b`, "g"))) {
    const from = match.index + match[0].length;
    const open = text.indexOf("{", from);
    if (open === -1) continue;
    let depth = 0;
    let close = open;
    for (; close < text.length; close++) {
      if (text[close] === "{") depth++;
      else if (text[close] === "}" && --depth === 0) break;
    }
    found.push({ header: text.slice(from, open), body: text.slice(open + 1, close) });
  }
  return found;
}
function memberNames(body) {
  const names = [];
  const head = /^[ \t]*(?:(?:readonly|get|set)\s+)?(\w+)\s*[?(:<]/;
  let depth = 0;
  let start = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (start && depth === 0) {
      const match = head.exec(body.slice(i, i + 200));
      if (match) names.push(match[1]);
    }
    start = false;
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "\n" || c === ";") start = true;
  }
  return names;
}
function bases(header) {
  let rest = header.trimStart();
  if (rest.startsWith("<")) {
    let depth = 0;
    let i = 0;
    for (; i < rest.length; i++) {
      if (rest[i] === "<") depth++;
      else if (rest[i] === ">" && --depth === 0) break;
    }
    rest = rest.slice(i + 1);
  }
  const match = /^\s*extends\b([\s\S]*)$/.exec(rest);
  return match ? [...match[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]) : [];
}
function contractOf(text, service) {
  const source = uncomment(text);
  const key = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let type = null;
  for (const { body } of interfaces(source, "TilrServices")) {
    const match = new RegExp(`(?:^|[\\s;,])${key}\\s*\\??\\s*:\\s*(\\w+)`).exec(body);
    if (match) {
      type = match[1];
      break;
    }
  }
  if (!type) return null;
  const declared = interfaces(source, type);
  if (!declared.length) return null;
  const names = /* @__PURE__ */ new Set();
  for (const { header, body } of declared) {
    for (const name of memberNames(body)) names.add(name);
    for (const base of bases(header)) {
      if (base === type) continue;
      for (const extended of interfaces(source, base)) for (const name of memberNames(extended.body)) names.add(name);
    }
  }
  return names;
}
function shows(el) {
  const named = `${CONTROL_SELECTOR}, [aria-label], [title], img[alt]`;
  const roots = [el];
  for (let root = roots.pop(); root; root = roots.pop()) {
    if (normalize(root.textContent ?? "") || root.querySelector(named)) return true;
    if (root instanceof Element && root.shadowRoot) roots.push(root.shadowRoot);
    for (const child of Array.from(root.querySelectorAll("*"))) if (child.shadowRoot) roots.push(child.shadowRoot);
  }
  return false;
}
function closest(el, selector) {
  for (let node = el; node; ) {
    const found = node.closest(selector);
    if (found) return found;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}
const WINDOW = ".window[data-window]";
const TILE = "#grid > .tile[data-type]";
function hidden(el) {
  if (el.hasAttribute("hidden") || attr(el, "aria-hidden") === "true" || el.hasAttribute("inert")) return true;
  const style = getComputedStyle(el);
  return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
}
function valueOf(el, role) {
  if (el instanceof HTMLInputElement) {
    if (CHECKABLE.has(role) || role === "button") return void 0;
    return el.type === "password" ? el.value ? "•••" : "" : clip(el.value);
  }
  if (el instanceof HTMLTextAreaElement) return clip(el.value);
  if (el instanceof HTMLSelectElement) return clip(Array.from(el.selectedOptions).map((o) => normalize(o.text)).join(", "));
  if (role === "textbox" || role === "searchbox" || role === "combobox") return clip(normalize(attr(el, "aria-valuetext") ?? el.textContent ?? ""));
  if (role === "slider" || role === "spinbutton" || role === "progressbar") {
    const value = attr(el, "aria-valuetext") ?? attr(el, "aria-valuenow");
    return value ?? void 0;
  }
  return void 0;
}
function statesOf(el, role) {
  const out = [];
  if (CHECKABLE.has(role)) {
    const aria = attr(el, "aria-checked");
    const checked = el instanceof HTMLInputElement ? el.indeterminate ? "mixed" : el.checked : aria === "mixed" ? "mixed" : aria === "true";
    out.push(checked === "mixed" ? "mixed" : checked ? "checked" : "unchecked");
  }
  if (disabled(el)) out.push("disabled");
  if (el === deepActive()) out.push("focused");
  if (el instanceof HTMLOptionElement && el.selected || attr(el, "aria-selected") === "true") out.push("selected");
  const expanded = attr(el, "aria-expanded");
  if (expanded === "true") out.push("expanded");
  else if (expanded === "false") out.push("collapsed");
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly || attr(el, "aria-readonly") === "true") out.push("readonly");
  if (attr(el, "aria-pressed") === "true") out.push("pressed");
  const current = attr(el, "aria-current");
  if (current !== null && current !== "false") out.push("current");
  return out;
}
function disabled(el) {
  return el.matches(":disabled") || closest(el, "[aria-disabled=true]") !== null;
}
function deepActive() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
const settle = () => new Promise((done) => {
  const timer = setTimeout(done, 100);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(timer);
    done();
  }));
});
function setValue(el, value) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
class Agent {
  /** Element → ref, and back (weakly: a ref does not keep a removed element alive). */
  refs = /* @__PURE__ */ new WeakMap();
  elements = /* @__PURE__ */ new Map();
  next = 1;
  /** Refs that are no element: an AgentAdapter's actions, `<window>\0<name>` → ref and back. */
  actionRefs = /* @__PURE__ */ new Map();
  actions = /* @__PURE__ */ new Map();
  /** While a snapshot is taken: the documents (a mounted window's content, its type having an
   *  adapter) and how many lines of their text to show. */
  documents = /* @__PURE__ */ new Map();
  lines = LINES;
  /** Elements the watcher has warned about. */
  warned = /* @__PURE__ */ new WeakSet();
  /** The open windows, and who owns an element: the runtime's (the layout's rows, the grid). */
  frames;
  owner;
  constructor(frames, owner) {
    this.frames = frames;
    this.owner = owner;
  }
  /** The ref of `el`, issued on first sight. */
  ref(el) {
    let ref = this.refs.get(el);
    if (!ref) {
      ref = `e${this.next++}`;
      this.refs.set(el, ref);
      this.elements.set(ref, new WeakRef(el));
    }
    return ref;
  }
  /** The ref of an adapter's action of the window `window`. */
  actionRef(window, name) {
    const key = `${window}\0${name}`;
    let ref = this.actionRefs.get(key);
    if (!ref) {
      ref = `e${this.next++}`;
      this.actionRefs.set(key, ref);
      this.actions.set(ref, { window, name });
    }
    return ref;
  }
  /** The live element of `ref`. */
  element(ref) {
    const el = this.elements.get(ref)?.deref();
    if (!el || !el.isConnected) throw new Error(`ref ${ref} is gone: take a new snapshot`);
    return el;
  }
  snapshot(options = {}) {
    const frames = this.frames().filter((frame) => options.window === void 0 || frame.id === options.window);
    if (options.window !== void 0 && !frames.length) throw new Error(`no window "${options.window}" is open`);
    const windows = frames.map((frame) => this.window(frame, options.lines));
    this.prune();
    return options.format === "json" ? windows : formatSnapshot(windows);
  }
  window(frame, lines = LINES) {
    const { id, type, title, mode, focused, parent, host, content, agent, handle } = frame;
    const win = { id, type, title, mode, focused, ...parent ? { parent } : {}, nodes: [] };
    if (!host || !host.isConnected || closest(host, "[hidden], [inert]") || hiddenUp(host)) win.hidden = true;
    else {
      this.lines = lines;
      this.documents = new Map(content && agent && handle && (agent.text || agent.input || agent.actions) ? [[content, frame]] : []);
      try {
        win.nodes = this.children(host);
      } finally {
        this.documents = /* @__PURE__ */ new Map();
      }
    }
    return win;
  }
  /** The nodes below `el`: its children's, containers without a role looked through. */
  children(el) {
    const out = [];
    const quiet = el instanceof Element && (tag(el) === "LABEL" && el.control || el.matches(".tile > header"));
    const kids = el instanceof Element && el.shadowRoot ? [...Array.from(el.shadowRoot.childNodes), ...Array.from(el.childNodes)] : Array.from(el.childNodes);
    for (const child of kids) {
      if (child.nodeType === 3) {
        const text = normalize(child.textContent ?? "");
        if (text && !quiet) out.push({ ref: "", role: "text", name: clip(text) });
        continue;
      }
      if (!(child instanceof Element) || SKIP.has(tag(child))) continue;
      if (child.matches(WINDOW)) continue;
      if (hidden(child)) continue;
      out.push(...this.nodes(child));
    }
    const merged = [];
    for (const node of out) {
      const last = merged[merged.length - 1];
      if (node.role === "text" && last?.role === "text" && !last.ref) last.name = clip(`${last.name} ${node.name}`);
      else merged.push(node);
    }
    return merged;
  }
  /** `el` as nodes: one with its role, or its children's when it has none. */
  nodes(el) {
    const doc = this.documents.get(el);
    if (doc?.agent && doc.handle) {
      const node2 = documentNode(this.ref(el), doc.title, doc.type, doc.agent, doc.handle, this.lines, (name) => this.actionRef(doc.id, name));
      const children2 = [...node2.children ?? [], ...this.children(el)];
      if (children2.length) node2.children = children2;
      return [node2];
    }
    const tagName = tag(el);
    if (MEDIA.has(tagName)) {
      const name = accessibleName(el);
      return name || attr(el, "role") ? [{ ref: this.ref(el), role: roleOf(el) ?? "img", name }] : [];
    }
    const role = roleOf(el);
    if (!role) return this.children(el);
    const node = { ref: this.ref(el), role, name: accessibleName(el) };
    const value = valueOf(el, role);
    if (value !== void 0) node.value = value;
    const state = statesOf(el, role);
    if (state.length) node.state = state;
    const call = attr(el, "data-call");
    if (call) node.call = call;
    if (TEXTUAL.has(role) || isControl(role) && role !== "focusable") return [node];
    const children = this.children(el);
    if (children.every((child) => child.role === "text")) {
      if (!node.name) node.name = clip(children.map((child) => child.name).join(" "));
      return node.name || isControl(role) || role === "listitem" ? [node] : [];
    }
    node.children = children;
    return [node];
  }
  /** Forgets refs whose element is gone. */
  prune() {
    for (const [ref, weak] of this.elements) if (!weak.deref()?.isConnected) this.elements.delete(ref);
    const open = new Set(this.frames().map((frame) => frame.id));
    for (const [ref, { window, name }] of this.actions) {
      if (open.has(window)) continue;
      this.actions.delete(ref);
      this.actionRefs.delete(`${window}\0${name}`);
    }
  }
  /** The window `el` is in. */
  frameOf(el) {
    const host = closest(el, `${WINDOW}, ${TILE}`);
    if (!host) return void 0;
    const id = host.getAttribute("data-window") ?? host.getAttribute("data-type");
    return this.frames().find((frame) => frame.id === id);
  }
  async act(ref, action, value, options = {}) {
    const wait = options.wait ? waitOptions(options.wait) : null;
    const verb = this.actions.get(ref);
    if (verb) return this.verb(ref, verb, action, wait, options);
    const el = ref === "" ? deepActive() ?? document.body : this.element(ref);
    const frames = this.frames();
    const frame = this.frameOf(el) ?? (ref === "" ? frames.find((f) => f.focused) ?? frames[0] : void 0);
    const name = ref || "the focused element";
    const html = el;
    const need = (ok, what) => {
      if (!ok) throw new Error(`${name} (${roleOf(el) ?? tag(el).toLowerCase()}) cannot ${what}`);
    };
    const enabled = () => {
      if (disabled(el)) throw new Error(`${name} is disabled`);
    };
    const own = frame && (el === frame.content || el === frame.host) ? frame : void 0;
    const unfillable = () => {
      const role = own?.agent && el === own.content ? "document" : roleOf(el) ?? tag(el).toLowerCase();
      const label = role === "document" ? normalize(own?.title ?? "") : accessibleName(el);
      return new Error(`${role} ${quote(label)} cannot be filled; a window with no field needs agent.input on its WindowType (see AgentAdapter)`);
    };
    switch (action) {
      case "click":
        enabled();
        el.scrollIntoView({ block: "nearest" });
        if (typeof html.click === "function") html.click();
        else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
        break;
      case "dblclick":
        enabled();
        el.scrollIntoView({ block: "nearest" });
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true, detail: 2 }));
        break;
      case "fill": {
        const text = value ?? "";
        if (own?.agent?.input && own.handle) {
          await own.agent.input(own.handle, text);
          break;
        }
        enabled();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (!(roleOf(el) === "textbox" || roleOf(el) === "searchbox" || roleOf(el) === "combobox" || roleOf(el) === "slider")) throw unfillable();
          if (el.readOnly) throw new Error(`${name} is read-only`);
          el.focus();
          setValue(el, text);
        } else {
          const editable = attr(el, "contenteditable");
          if (editable === null || editable === "false") throw unfillable();
          html.focus();
          el.textContent = text;
        }
        fire(el, "input");
        fire(el, "change");
        break;
      }
      case "select": {
        enabled();
        const wanted = value ?? "";
        if (el instanceof HTMLSelectElement) {
          const option = Array.from(el.options).find((o) => o.value === wanted) ?? Array.from(el.options).find((o) => normalize(o.text) === normalize(wanted));
          if (!option) throw new Error(`${name} has no option "${wanted}" (${Array.from(el.options).map((o) => quote(normalize(o.text))).join(", ")})`);
          el.focus();
          setValue(el, option.value);
          fire(el, "input");
          fire(el, "change");
        } else {
          const options2 = roleOf(el) === "option" ? [el] : Array.from(el.querySelectorAll("[role=option]"));
          need(options2.length > 0, "select (not a <select>, a listbox or an option)");
          const option = roleOf(el) === "option" ? el : options2.find((o) => attr(o, "data-value") === wanted || accessibleName(o) === normalize(wanted));
          if (!option) throw new Error(`${name} has no option "${wanted}" (${options2.map((o) => quote(accessibleName(o))).join(", ")})`);
          option.scrollIntoView({ block: "nearest" });
          option.click();
        }
        break;
      }
      case "check":
      case "uncheck": {
        const role = roleOf(el) ?? "";
        need(CHECKABLE.has(role), action);
        const checked = el instanceof HTMLInputElement ? el.checked : attr(el, "aria-checked") === "true";
        if (checked === (action === "check")) break;
        enabled();
        el.scrollIntoView({ block: "nearest" });
        html.click();
        break;
      }
      case "focus":
        need(typeof html.focus === "function", "take the focus");
        html.focus();
        break;
      case "press": {
        const key = parseKey(value ?? "");
        const init = { ...key, bubbles: true, cancelable: true, composed: true };
        const down = el.dispatchEvent(new KeyboardEvent("keydown", init));
        if (down && key.key.length === 1 && !key.metaKey && !key.ctrlKey) el.dispatchEvent(new KeyboardEvent("keypress", init));
        el.dispatchEvent(new KeyboardEvent("keyup", init));
        if (down && key.key === "Enter" && el instanceof HTMLInputElement && el.form) el.form.requestSubmit();
        break;
      }
      case "scroll":
        el.scrollIntoView({ block: "center" });
        break;
      default:
        throw new Error(`unknown action "${String(action)}": click, dblclick, fill, select, check, uncheck, focus, press, scroll`);
    }
    return this.after(frame, wait, options);
  }
  /** `act` on an adapter's action: a click calls it. */
  async verb(ref, { window, name }, action, wait, options) {
    const frame = this.frames().find((f) => f.id === window);
    const run = frame?.handle && frame.agent?.actions?.[name];
    if (!frame || !run) throw new Error(`ref ${ref} is gone: take a new snapshot`);
    if (action !== "click") throw new Error(`button ${quote(name)} (an action of ${frame.type}) can only be clicked`);
    await run(frame.handle);
    return this.after(frame, wait, options);
  }
  /** After an action: the page redrawn, the wait if asked for, the window's snapshot. */
  async after(frame, wait, options) {
    await settle();
    if (!frame) return options.format === "json" ? null : "no windows";
    let timedOut;
    if (wait) {
      const live = this.frames().find((f) => f.id === frame.id);
      if (live && !await this.wait(live, wait)) timedOut = wait.timeoutMs;
    }
    const now = this.frames().find((f) => f.id === frame.id);
    const win = now ? this.window(now, options.lines) : { id: frame.id, type: frame.type, title: frame.title, mode: frame.mode, focused: false, closed: true, nodes: [] };
    if (timedOut !== void 0) win.timedOut = timedOut;
    return options.format === "json" ? win : formatSnapshot([win]);
  }
  /** Waits for `frame`: its adapter's `wait` (given up on after `timeoutMs`; resolved with an
   *  `until`, the text is checked here too, the adapter may have resolved on its own timeout),
   *  else its DOM and text (`waitFor`). False: timed out. */
  async wait(frame, wait) {
    const { agent, handle, host } = frame;
    if (agent?.wait && handle) {
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), wait.timeoutMs);
      });
      const done = Promise.resolve().then(() => agent.wait?.(handle, wait.until, { idleMs: wait.idleMs, timeoutMs: wait.timeoutMs })).then(() => true, () => false);
      let settled;
      try {
        settled = await Promise.race([done, late]);
      } finally {
        clearTimeout(timer);
      }
      if (!settled || !wait.until) return settled;
      const until = wait.until;
      try {
        return matchesText(until, agent.text ? String(agent.text(handle) ?? "") : host?.textContent ?? "");
      } catch {
        return false;
      }
    }
    if (!host) return true;
    return waitFor({
      observe(changed) {
        const observer = new MutationObserver(changed);
        observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
        return () => observer.disconnect();
      },
      text: () => agent?.text && handle ? String(agent.text(handle) ?? "") : host.textContent ?? ""
    }, wait);
  }
  /**
   * Warns about controls without an accessible name as they come into windows: once per
   * element, `report` is told whose it is. Checked a moment after they arrive (a plugin may
   * name a control right after appending it). Looks only: never changes the plugin's DOM.
   * Returns the stop.
   */
  watch(report) {
    const pending = /* @__PURE__ */ new Set();
    let timer = null;
    const check = () => {
      timer = null;
      for (const root of pending) {
        if (!root.isConnected) continue;
        const candidates = root.matches(CONTROL_SELECTOR) ? [root, ...Array.from(root.querySelectorAll(CONTROL_SELECTOR))] : Array.from(root.querySelectorAll(CONTROL_SELECTOR));
        for (const el of candidates) {
          if (this.warned.has(el)) continue;
          const role = roleOf(el);
          if (!role || !isControl(role) || accessibleName(el)) continue;
          const owner = this.owner(el);
          if (!owner) continue;
          this.warned.add(el);
          report(owner, el);
        }
      }
      pending.clear();
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element && closest(node, `${WINDOW}, .tile`)) pending.add(node);
          else if (node instanceof Element && node.querySelector(`${WINDOW}, .tile`)) pending.add(node);
        }
      }
      if (pending.size && !timer) timer = setTimeout(check, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }
}
function hiddenUp(el) {
  for (let node = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return true;
  }
  return false;
}
function describeElement(el) {
  const role = attr(el, "role");
  return `<${tag(el).toLowerCase()}${role ? ` role=${role}` : ""}>`;
}
export {
  Agent,
  CONTROL_SELECTOR,
  LINES,
  accessibleName,
  clip,
  closest,
  contractOf,
  describeElement,
  documentNode,
  formatSnapshot,
  isControl,
  matchesText,
  members,
  normalize,
  ownText,
  parseKey,
  roleOf,
  serviceProxy,
  shows,
  tail,
  trimLines,
  waitFor,
  waitOptions
};
//# sourceMappingURL=agent.js.map
