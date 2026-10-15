import { jsx, jsxs } from "react/jsx-runtime";
import { useEffect, useReducer } from "react";
import { mount, useCtx, useWindow, windowRoot } from "tilr/react";
import { Frame } from "tilr/ui";
const MODES = ["tile", "float"];
const css = `
  .winlist { display: flex; flex-direction: column; gap: 6px; height: 100%; }
  .winlist input[type=search] { box-sizing: border-box; width: 100%; font: inherit; color: inherit;
    background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 2px 6px; }
  .winlist input[type=search]:focus { outline: none; border-color: var(--accent); }
  .winlist ul { list-style: none; margin: 0; padding: 0; }
  .winlist .group > .head { display: flex; gap: 6px; align-items: baseline; padding: 4px 0 2px; cursor: default; user-select: none; }
  .winlist .group > .head .arrow { width: 10px; color: var(--muted); font-size: 10px; }
  .winlist .group > .head .count { color: var(--muted); font-size: 10px; flex: 1; }
  .winlist .group > .head button { padding: 0 6px; line-height: 1.3; }
  .winlist .group.closed > ul { display: none; }
  .winlist .group > ul { padding-left: 16px; }
  .winlist .row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto auto; gap: 8px; align-items: center; padding: 2px 0; cursor: default; }
  .winlist .row:hover .name { color: var(--accent); }
  .winlist .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
  .winlist .dot.focused { background: var(--accent); }
  .winlist .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .winlist .mode { color: var(--muted); font-size: 10px; }
  .winlist .row button { padding: 0 5px; line-height: 1.3; }
  .winlist .row .blank { width: 21px; }
  .winlist .empty { color: var(--muted); padding: 4px 0; }
`;
function predicates(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean).map((token) => {
    if (MODES.includes(token)) return (w) => w.mode === token;
    if (token === "focused") return (w) => w.focused;
    return (w) => w.title.toLowerCase().includes(token) || w.type.toLowerCase().includes(token);
  });
}
function groups(rows, types, query) {
  const tests = predicates(query);
  const shown2 = rows.filter((w) => tests.every((test) => test(w)));
  const byType = /* @__PURE__ */ new Map();
  for (const type of types) byType.set(type, []);
  for (const w of shown2) byType.set(w.type, [...byType.get(w.type) ?? [], w]);
  return [...byType].filter(([, list]) => !query.trim() || list.length).map(([type, list]) => ({ type, rows: list }));
}
function openable(def) {
  return !!def;
}
function closable(def) {
  void def;
  return true;
}
function shown(rows, title) {
  return JSON.stringify(rows.map((w) => [w.id, w.type, w.title, w.mounted, w.mode, w.modes.length, w.focused, w.mode === "nested" && w.parent ? title(w.parent) ?? null : null]));
}
function Windows() {
  const ctx = useCtx();
  const win = useWindow(["config"]);
  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    const off = ctx.on("windows/change", bump);
    bump();
    return () => {
      off();
    };
  }, [ctx]);
  const config = { query: win.config?.query ?? "", closed: win.config?.closed ?? [] };
  const closed = new Set(config.closed);
  const set = (patch) => win.setConfig({ ...config, ...patch });
  const rows = ctx.layout.list();
  const title = (id) => ctx.layout.get(id)?.title;
  const drawn = shown(rows, title);
  useEffect(() => {
    let queued = false;
    let live = true;
    const check = () => {
      if (live && shown(ctx.layout.list(), title) !== drawn) bump();
    };
    check();
    const off = win.subscribe(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        check();
      });
    });
    return () => {
      live = false;
      off();
    };
  });
  const list = groups(rows, ctx.windows.list(), config.query);
  return /* @__PURE__ */ jsx(Frame, { children: /* @__PURE__ */ jsxs("div", { className: "winlist", children: [
    /* @__PURE__ */ jsx("input", { type: "search", placeholder: "search", spellCheck: false, value: config.query, onChange: (e) => set({ query: e.target.value }) }),
    /* @__PURE__ */ jsxs("ul", { className: "tree", children: [
      list.map(({ type, rows: rows2 }) => {
        const def = ctx.windows.get(type);
        const fold = closed.has(type) && rows2.length > 0;
        return /* @__PURE__ */ jsxs("li", { className: fold ? "group closed" : "group", children: [
          /* @__PURE__ */ jsxs("div", { className: "head", onClick: () => set({ closed: fold ? config.closed.filter((t) => t !== type) : [...config.closed, type] }), children: [
            /* @__PURE__ */ jsx("span", { className: "arrow", children: rows2.length ? fold ? "▸" : "▾" : "" }),
            /* @__PURE__ */ jsx("span", { className: def ? "label" : "label muted", children: type }),
            /* @__PURE__ */ jsx("span", { className: "count", children: rows2.length }),
            openable(def) && /* @__PURE__ */ jsx("button", { title: `open a ${type}`, "data-call": "layout.open", onClick: (e) => {
              e.stopPropagation();
              ctx.layout.open({ type });
            }, children: "+" })
          ] }),
          /* @__PURE__ */ jsx("ul", { children: rows2.map((w) => /* @__PURE__ */ jsxs("li", { className: "row", "data-window-row": w.id, onClick: () => ctx.layout.focus(w.id), children: [
            /* @__PURE__ */ jsx("span", { className: w.focused ? "dot focused" : "dot" }),
            /* @__PURE__ */ jsx("span", { className: "name", title: w.mounted ? w.title : `${w.title} (waiting for ${w.type})`, children: w.title }),
            /* @__PURE__ */ jsx("span", { className: "mode", children: w.mode === "nested" ? `in ${(w.parent && ctx.layout.get(w.parent)?.title) ?? "?"}` : w.mode }),
            w.modes.length > 1 ? /* @__PURE__ */ jsx("button", { title: w.mode === "float" ? "tile" : "float", "data-call": w.mode === "float" ? "layout.tile" : "layout.float", onClick: (e) => {
              e.stopPropagation();
              w.mode === "float" ? ctx.layout.tile(w.id) : ctx.layout.float(w.id);
            }, children: "⧉" }) : /* @__PURE__ */ jsx("span", { className: "blank" }),
            closable(def) ? /* @__PURE__ */ jsx("button", { title: "close", "data-call": "layout.close", onClick: (e) => {
              e.stopPropagation();
              ctx.layout.close(w.id);
            }, children: "×" }) : /* @__PURE__ */ jsx("span", { className: "blank" })
          ] }, w.id)) })
        ] }, type);
      }),
      !list.length && /* @__PURE__ */ jsx("li", { className: "empty", children: rows.length ? "nothing matches" : "no windows" })
    ] })
  ] }) });
}
var windows_default = {
  name: "windows",
  author: "tilr",
  tags: ["chrome"],
  version: "0.1.14",
  inject: ["ui", "windows", "layout"],
  apply(ctx) {
    ctx.ui.style(css);
    ctx.windows.register("windows", {
      title: "windows",
      defaultConfig: { query: "", closed: [] },
      mount: (host, win) => mount(host, windowRoot(ctx, win, /* @__PURE__ */ jsx(Windows, {})))
    });
  }
};
export {
  closable,
  windows_default as default,
  groups,
  openable,
  predicates,
  shown
};
//# sourceMappingURL=index.js.map
