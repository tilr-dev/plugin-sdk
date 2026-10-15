import { definePlugin } from "tilr";
const NONE = "—";
const STATUSES = ["on", "off", "failed", "incompatible"];
const VIEWS = [
  { id: "author", label: "author", groups: (p) => [p.author ?? NONE] },
  { id: "tag", label: "tag", groups: (p) => p.tags.length ? p.tags : [NONE] },
  { id: "uses", label: "uses", groups: (p) => p.injects.length ? p.injects : [NONE] },
  { id: "status", label: "status", groups: (p) => [status(p)] }
];
const css = `
  .panel .bar { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
  .panel .bar input[type=search] { box-sizing: border-box; width: 100%; font: inherit; color: inherit;
    background: var(--bg, #000); border: 1px solid var(--line, #1e1e2e); border-radius: var(--radius, 4px); padding: 2px 6px; }
  .panel .bar input[type=search]:focus { outline: none; border-color: var(--accent, #6dd08c); }
  .panel .tabs { display: flex; gap: 2px; }
  .panel .tabs button { padding: 1px 6px; color: var(--muted, #9399b2); }
  .panel .tabs button.on { color: var(--on-accent, #000); background: var(--accent, #6dd08c); }
  .panel ul { list-style: none; margin: 0; padding: 0; }
  .panel .group > .head { display: flex; gap: 6px; align-items: baseline; padding: 4px 0 2px; cursor: default; user-select: none; }
  .panel .group > .head .arrow { width: 10px; color: var(--muted, #9399b2); font-size: 10px; }
  .panel .group > .head .count { color: var(--muted, #9399b2); font-size: 10px; }
  .panel .group.closed > ul { display: none; }
  .panel .group > ul { padding-left: 16px; }
  .panel .row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto auto; gap: 10px; align-items: center; padding: 3px 0; }
  .panel .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .panel .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line, #1e1e2e); }
  .panel .dot.active { background: var(--accent, #6dd08c); }
  .panel .dot.failed, .panel .dot.incompatible { background: var(--danger, #ff5d5d); }
  .panel .dot.pending, .panel .dot.loading { background: var(--muted, #9399b2); }
  .panel .name small { color: var(--muted, #9399b2); font-size: 10px; margin-left: 6px; }
  .panel .name small.a11y { color: var(--danger, #ff5d5d); }
  .panel .state { color: var(--muted, #9399b2); font-size: 11px; }
  .panel .error { grid-column: 1 / -1; color: var(--danger, #ff5d5d); font-size: 11px; white-space: pre-wrap; }
  .panel .empty { color: var(--muted, #9399b2); padding: 4px 0; }
`;
function status(p) {
  return p.state === "failed" || p.state === "incompatible" ? p.state : p.enabled ? "on" : "off";
}
function predicates(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean).map((token) => {
    const [key, value] = token.includes(":") ? token.split(/:(.*)/, 2) : ["", token];
    if (key === "author") return (p) => (p.author ?? "").toLowerCase().includes(value);
    if (key === "tag") return (p) => p.tags.some((tag) => tag.toLowerCase().includes(value));
    if (key === "uses") return (p) => p.injects.some((name) => name.toLowerCase().includes(value));
    if (STATUSES.includes(token)) return (p) => status(p) === token;
    return (p) => p.name.toLowerCase().includes(token);
  });
}
function candidates(rows) {
  const out = new Set(STATUSES);
  for (const p of rows) {
    out.add(p.name);
    if (p.author) out.add(`author:${p.author}`);
    for (const tag of p.tags) out.add(`tag:${tag}`);
    for (const name of p.injects) out.add(`uses:${name}`);
  }
  return [...out].sort();
}
function drawing(rows, view, query, closed) {
  return JSON.stringify([rows.map((p) => ({ ...p, error: p.error?.message ?? null })), view, query, [...closed]]);
}
function load(saved) {
  const state = { view: "author", query: "", closed: [] };
  if (typeof saved !== "object" || saved === null) return state;
  if ("view" in saved && typeof saved.view === "string") state.view = saved.view;
  if ("query" in saved && typeof saved.query === "string") state.query = saved.query;
  if ("closed" in saved && Array.isArray(saved.closed)) state.closed = saved.closed.filter((key) => typeof key === "string");
  return state;
}
var panel_default = definePlugin({
  name: "panel",
  author: "tilr",
  tags: ["chrome"],
  version: "0.1.14",
  locked: true,
  inject: ["ui", "plugins", "store"],
  apply(ctx) {
    ctx.ui.style(css);
    const body = ctx.ui.tile({ title: "plugins" });
    body.classList.add("panel");
    body.innerHTML = `
      <div class="bar">
        <input type="search" list="tilr-panel-list" placeholder="search" spellcheck="false">
        <datalist id="tilr-panel-list"></datalist>
        <nav class="tabs"></nav>
      </div>
      <ul class="tree"></ul>`;
    const search = body.querySelector("input");
    const datalist = body.querySelector("datalist");
    const tabs = body.querySelector(".tabs");
    const tree = body.querySelector(".tree");
    const area = ctx.store.area("panel");
    const save = (state2) => area.set("state", state2);
    const state = load(area.get("state"));
    if (!VIEWS.some((v) => v.id === state.view)) state.view = VIEWS[0].id;
    const closed = new Set(state.closed);
    search.value = state.query;
    for (const view of VIEWS) {
      const tab = document.createElement("button");
      tab.textContent = view.label;
      tab.onclick = () => {
        state.view = view.id;
        save({ ...state, closed: [...closed] });
        render();
      };
      tabs.append(tab);
    }
    search.oninput = () => {
      state.query = search.value;
      save({ ...state, closed: [...closed] });
      render();
    };
    function row(plugin) {
      const li = document.createElement("li");
      li.className = "row";
      li.innerHTML = `
        <span class="dot"></span><span class="name"></span><span class="state"></span>
        <button title="reload from disk" data-call="plugins.reload">↻</button>
        <input class="switch" type="checkbox" title="on / off" data-call="plugins.toggle">`;
      const [dot, name, st, reload, toggle] = [...li.children];
      dot.classList.add(plugin.state);
      name.textContent = plugin.name;
      const provides = plugin.provides && plugin.provides !== plugin.name ? `→ ${plugin.provides}` : null;
      const chips = [plugin.version && `v${plugin.version}`, provides, plugin.author, ...plugin.tags.map((t) => `#${t}`)];
      for (const chip of chips.filter(Boolean)) {
        const small = document.createElement("small");
        small.textContent = chip;
        name.append(small);
      }
      if (plugin.unnamed || plugin.blind) {
        const badge = document.createElement("small");
        badge.className = "a11y";
        badge.textContent = "a11y";
        badge.title = [
          plugin.unnamed && `${plugin.unnamed} control${plugin.unnamed === 1 ? "" : "s"} without a name: give each text, aria-label or a <label>`,
          plugin.blind && `${plugin.blind} window${plugin.blind === 1 ? "" : "s"} showing agents nothing: add agent.text to the WindowType`
        ].filter(Boolean).join("; ") + " (see the console)";
        name.append(badge);
      }
      reload.setAttribute("aria-label", `reload ${plugin.name}`);
      toggle.setAttribute("aria-label", `${plugin.name} on / off`);
      st.textContent = plugin.state === "active" ? "" : plugin.state;
      if (plugin.loadedAt) li.title = `loaded ${new Date(plugin.loadedAt).toLocaleTimeString("en-GB")}`;
      reload.onclick = () => ctx.plugins.reload(plugin.name).then(console.log, console.error);
      toggle.checked = plugin.enabled;
      toggle.disabled = plugin.locked;
      toggle.onchange = () => ctx.plugins.toggle(plugin.name).catch(console.error);
      if (plugin.error) {
        const error = document.createElement("div");
        error.className = "error";
        error.textContent = plugin.error.message;
        li.append(error);
      }
      return li;
    }
    function group(key, label, rows) {
      const li = document.createElement("li");
      li.className = "group";
      if (closed.has(key)) li.classList.add("closed");
      const head = document.createElement("div");
      head.className = "head";
      head.innerHTML = '<span class="arrow"></span><span class="label"></span><span class="count"></span>';
      head.children[0].textContent = closed.has(key) ? "▸" : "▾";
      head.children[1].textContent = label;
      head.children[2].textContent = String(rows.length);
      head.onclick = () => {
        closed.has(key) ? closed.delete(key) : closed.add(key);
        save({ ...state, closed: [...closed] });
        render();
      };
      const ul = document.createElement("ul");
      ul.append(...rows.map(row));
      li.append(head, ul);
      return li;
    }
    let drawn = null;
    function render() {
      const all = ctx.plugins.list();
      const view = VIEWS.find((v) => v.id === state.view) ?? VIEWS[0];
      const signature = drawing(all, view.id, state.query, closed);
      if (signature === drawn) return;
      drawn = signature;
      for (const [i, tab] of [...tabs.children].entries()) tab.classList.toggle("on", VIEWS[i] === view);
      const head = search.value.replace(/\S*$/, "");
      datalist.replaceChildren(...candidates(all).map((c) => Object.assign(document.createElement("option"), { value: head + c })));
      const tests = predicates(state.query);
      const rows = all.filter((p) => tests.every((test) => test(p)));
      const groups = /* @__PURE__ */ new Map();
      for (const p of rows) {
        for (const g of view.groups(p)) groups.set(g, [...groups.get(g) ?? [], p]);
      }
      const keys = [...groups.keys()].sort((a, b) => Number(a === NONE) - Number(b === NONE) || a.localeCompare(b));
      const providers = new Map(all.filter((p) => p.provides).sort((x, y) => Number(x.state === "active") - Number(y.state === "active")).map((p) => [p.provides, p.name]));
      tree.replaceChildren(...keys.map((g) => {
        const label = view.id === "uses" && providers.has(g) && providers.get(g) !== g ? `${g} (${providers.get(g)})` : g;
        return group(`${view.id}/${g}`, label, groups.get(g) ?? []);
      }));
      if (!keys.length) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = all.length ? "nothing matches" : "no plugins";
        tree.append(empty);
      }
    }
    let queued = false;
    ctx.on("plugins/change", () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        render();
      });
    });
    render();
  }
});
export {
  candidates,
  panel_default as default,
  drawing,
  load,
  predicates,
  status
};
//# sourceMappingURL=index.js.map
