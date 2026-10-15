import { performanceCollector } from "./performance.js";
import { Service } from "cordis";
const reactMode = "dev";
function mark(name, detail) {
  if (performanceCollector) {
    const plugin = typeof detail === "object" && detail && "plugin" in detail ? String(detail.plugin) : name.startsWith("plugin:") ? name.split(" ").slice(1).join(" ") : "runtime";
    performanceCollector.event(name.startsWith("plugin:dispose ") ? "dispose" : "mark", plugin, name);
  }
}
function measure(name, start, end, detail) {
  if (performanceCollector) {
    const from = typeof start === "number" ? start : performanceCollector.marks.get(start);
    const to = typeof end === "number" ? end : typeof end === "string" ? performanceCollector.marks.get(end) : performance.now();
    if (from === void 0 || to === void 0) return;
    const plugin = typeof detail === "object" && detail && "plugin" in detail ? String(detail.plugin) : name.startsWith("plugin:") ? name.split(" ").slice(1).join(" ") : name.startsWith("layout:") ? "layout" : "runtime";
    performanceCollector.event(name.startsWith("plugin:start ") ? "start" : "operation", plugin, name, to - from);
  }
}
function collecting() {
  return performanceCollector !== void 0;
}
function metric(name, value, labels) {
  performanceCollector?.metric(name, value, labels);
}
function adopt(root, sheet) {
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  return () => {
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
  };
}
class Theme extends Service {
  constructor(ctx, { name, sheet }) {
    super(ctx, "theme");
    this.variant = name;
    this.sheet = sheet;
  }
  /**
   * A token's value as the theme sets it, trimmed ('' when it does not): `token('--bg')`. Read
   * off the root element, which is always rendered: an element's own computed style is stale
   * inside a hidden subtree (WebKit keeps a display: none tab's style from before a theme
   * switch). Plugins that inject `theme` are remounted on a switch, so a value read at mount
   * stays current.
   */
  token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  /** Gives a shadow root the theme's classes. The effect belongs to the calling plugin. */
  attach(root) {
    this.ctx.effect(() => adopt(root, this.sheet), "theme.attach()");
  }
}
function absoluteUrls(css, base) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, ref) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) return match;
    return `url("${new URL(ref, base)}")`;
  });
}
function theme(base, css, meta = {}) {
  const name = /\/plugins\/([^/]+)\//.exec(base)?.[1] ?? "theme";
  return {
    name,
    ...meta,
    provide: "theme",
    async apply(ctx) {
      const url = new URL(css, base);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${css}: ${response.status}`);
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(absoluteUrls(await response.text(), url));
      ctx.effect(() => adopt(document, sheet), "theme sheet");
      void ctx.plugin(Theme, { name, sheet });
    }
  };
}
function onLayout(ctx, listener, options = {}) {
  const ignore = options.ignore ?? [];
  return ctx.on("layout/change", (change) => {
    if (!change || !ignore.includes(change.kind)) listener(change);
  });
}
function optional(ctx, services, apply) {
  return ctx.inject(typeof services === "string" ? [services] : [...services], (scope) => apply(scope));
}
function definePlugin(plugin) {
  return plugin;
}
export {
  Theme,
  adopt,
  collecting,
  definePlugin,
  mark,
  measure,
  metric,
  onLayout,
  optional,
  reactMode,
  theme
};
//# sourceMappingURL=tilr.js.map
