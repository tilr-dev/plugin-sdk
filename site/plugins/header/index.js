import { definePlugin } from "tilr";
const ZONES = [
  { tz: "", tag: "", name: "Zurich" },
  { tz: "UTC", tag: "UTC", name: "UTC" },
  { tz: "America/New_York", tag: "NYC", name: "New York" },
  { tz: "Europe/Kyiv", tag: "KYIV", name: "Kyiv" },
  { tz: "Europe/Moscow", tag: "MSK", name: "Moscow" }
];
const HEIGHT = 32;
const css = `
  :host {
    position: fixed; inset: 0 0 auto 0; z-index: 2147483647;
    font: var(--font); line-height: 1; font-weight: bold;
    color: var(--text); cursor: default; user-select: none; -webkit-user-select: none;
  }
  /* 32pt is the notch strip. Items sit 1px below the middle, hence the top padding. */
  .bar {
    box-sizing: border-box; height: ${HEIGHT}px; padding: 2px 25px 0 17px;
    display: flex; align-items: stretch; justify-content: space-between;
    background: var(--bg); border-bottom: 1px solid var(--line);
  }
  .logo, .clock { display: flex; align-items: center; white-space: pre; }
  .tilde { margin-right: 3px; }
  .chevron { margin-left: 3px; }
  /* the "r": a glyph on an accent block that hangs 2px lower than the text */
  .block { position: relative; z-index: 0; padding: 0 3px 0 2px; color: var(--on-accent); }
  .block::before {
    content: ""; position: absolute; z-index: -1; left: 0; right: 0;
    top: calc(50% - 6.5px); height: 17px; border-radius: 2px; background: var(--accent);
  }
  /* digits over a thin accent rule */
  .clock { position: relative; padding: 0 4px; }
  .clock::after {
    content: ""; position: absolute; left: 0; right: 0;
    top: calc(50% + 9px); height: 2px; border-radius: 1px; background: var(--accent);
  }
  /* the dropdown hangs off the bar's bottom line, right edges aligned with the clock */
  .menu {
    position: absolute; top: ${HEIGHT - 1}px; right: 25px; padding: 0 5px;
    display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--line); border-radius: 0 0 var(--radius) var(--radius);
    color: var(--muted);
  }
  .menu[hidden] { display: none; }
  .row { width: 170px; height: 22px; margin: 2px 0; display: flex; align-items: center; white-space: pre; }
  .row:hover { background: var(--line); color: var(--accent); }
  .mark { font-size: 15px; margin: 0 12px 0 4px; }
`;
var header_default = definePlugin({
  name: "header",
  author: "dan",
  tags: ["chrome", "time"],
  version: "0.1.14",
  // Needs the theme: its classes (.accent) reach the shadow root through ctx.theme.attach().
  // ui: the dropdown is a popup, seen over the native web views too.
  inject: ["ui", "theme", "store"],
  apply(ctx) {
    const host = document.createElement("tilr-header");
    const root = host.attachShadow({ mode: "open" });
    ctx.theme.attach(root);
    root.innerHTML = `
      <style>${css}</style>
      <div class="bar">
        <div class="logo"><span class="accent tilde">~/</span><span>til</span><span class="block">r</span><span class="accent chevron">❯</span></div>
        <div class="clock"></div>
      </div>
      <div class="menu" hidden></div>`;
    const clock = root.querySelector(".clock");
    const menu = root.querySelector(".menu");
    const popup = ctx.ui.popup(menu, { anchor: host });
    const area = ctx.store.area("header");
    const selected = () => {
      const index = area.get("zone");
      return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < ZONES.length ? index : 0;
    };
    const timeIn = (zone) => new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone.tz || void 0
    }).format(/* @__PURE__ */ new Date());
    function render() {
      const zone = ZONES[selected()];
      const text = zone.tag ? `${zone.tag} ${timeIn(zone)}` : timeIn(zone);
      if (clock.textContent !== text) clock.textContent = text;
      if (popup.opened) renderRows();
    }
    function renderRows() {
      const current = selected();
      const rows = ZONES.map((zone, index) => `${index === current ? "●" : "○"}|${zone.name.padEnd(9)} ${timeIn(zone)}`);
      if (menu.dataset.rows === rows.join("\n")) return;
      menu.dataset.rows = rows.join("\n");
      menu.replaceChildren(...rows.map((row, index) => {
        const [mark, label] = row.split("|");
        const element = document.createElement("div");
        element.className = "row";
        element.innerHTML = '<span class="mark"></span><span class="label"></span>';
        element.children[0].textContent = mark;
        element.children[1].textContent = label;
        element.onclick = () => {
          area.set("zone", index);
          popup.close();
          render();
        };
        return element;
      }));
    }
    clock.onclick = () => {
      if (!popup.opened) {
        delete menu.dataset.rows;
        renderRows();
      }
      popup.toggle();
    };
    host.addEventListener("mousedown", (event) => event.preventDefault());
    const push = document.createElement("style");
    push.textContent = `body{margin-top:${HEIGHT}px!important;height:calc(100dvh - ${HEIGHT}px)!important}`;
    ctx.effect(() => {
      document.head.append(push);
      document.documentElement.append(host);
      return () => {
        host.remove();
        push.remove();
      };
    }, "header dom");
    render();
    ctx.effect(() => {
      const id = setInterval(render, 1e4);
      return () => clearInterval(id);
    }, "header clock");
  }
});
export {
  header_default as default
};
//# sourceMappingURL=index.js.map
