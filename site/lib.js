function injects(plugin) {
  const inject = plugin?.inject;
  if (!inject) return [];
  if (Array.isArray(inject)) return [...inject];
  const names = [];
  for (let o = inject; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) names.push(...Object.keys(o));
  return [...new Set(names)];
}
function hasDefault(module) {
  if (typeof module !== "object" || module === null || !("default" in module)) return false;
  const plugin = module.default;
  return typeof plugin === "function" || typeof plugin === "object" && plugin !== null && "apply" in plugin && typeof plugin.apply === "function";
}
const BUILD_STAMP = "__tilrBuild";
function stampBuild(module) {
  if (!(BUILD_STAMP in module)) return;
  const stamp = module[BUILD_STAMP];
  if (typeof stamp !== "object" || stamp === null) return;
  const plugin = module.default;
  for (const key of ["version", "api"]) {
    const value = key in stamp ? stamp[key] : void 0;
    if (typeof value !== "string" || plugin[key] !== void 0) continue;
    try {
      Object.defineProperty(plugin, key, { value, configurable: true, enumerable: true, writable: true });
    } catch {
    }
  }
}
function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
function pluginNames(json) {
  if (typeof json === "object" && json !== null && "plugins" in json && Array.isArray(json.plugins)) {
    return json.plugins.filter((name) => typeof name === "string");
  }
  throw new Error('plugins.json: expected { "plugins": [names] }');
}
const TAG = String.raw`(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const VERSION = new RegExp(String.raw`^v?(\d+)\.(\d+)\.(\d+)${TAG}$`);
const COMPARATOR = new RegExp(String.raw`^(<=|>=|<|>|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?${TAG}$`);
function parseVersion(version) {
  const match = typeof version === "string" ? VERSION.exec(version.trim()) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function compare(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function bump(parts, i) {
  const out = [0, 0, 0];
  for (let k = 0; k < i; k++) out[k] = parts[k];
  out[i] = parts[i] + 1;
  return out;
}
function comparator(token) {
  const match = COMPARATOR.exec(token);
  if (!match) return null;
  const op = match[1] ?? "=";
  const parts = [];
  for (const part of match.slice(2, 5)) {
    if (part === void 0 || !/^\d+$/.test(part)) break;
    parts.push(Number(part));
  }
  if (!parts.length) return op === "<" || op === ">" ? () => false : () => true;
  const low = [parts[0], parts[1] ?? 0, parts[2] ?? 0];
  const high = bump(parts, parts.length - 1);
  const within = (top) => (v) => compare(v, low) >= 0 && compare(v, top) < 0;
  switch (op) {
    case "=":
      return within(high);
    case ">=":
      return (v) => compare(v, low) >= 0;
    case ">":
      return (v) => compare(v, high) >= 0;
    case "<":
      return (v) => compare(v, low) < 0;
    case "<=":
      return (v) => compare(v, high) < 0;
    // ~1.2.3, ~1.2 → <1.3.0; ~1 → <2.0.0
    case "~":
      return within(bump(parts, parts.length > 1 ? 1 : 0));
    // ^ bumps the first non-zero part given, or the last one if all are zero:
    // ^1.2.3 → <2.0.0, ^0.2.3 → <0.3.0, ^0.0.3 → <0.0.4, ^0 → <1.0.0, ^0.0 → <0.1.0
    default: {
      const first = parts.findIndex((part) => part !== 0);
      return within(bump(parts, first === -1 ? parts.length - 1 : first));
    }
  }
}
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v || typeof range !== "string") return false;
  const alternatives = range.replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1").split("||").map((alternative) => {
    const tests = alternative.trim().split(/\s+/).filter(Boolean).map(comparator);
    return tests.every((test) => test !== null) ? tests : null;
  });
  if (alternatives.some((tests) => tests === null)) return false;
  return alternatives.some((tests) => tests?.every((test) => test(v)));
}
export {
  BUILD_STAMP,
  asError,
  hasDefault,
  injects,
  parseVersion,
  pluginNames,
  satisfies,
  stampBuild
};
//# sourceMappingURL=lib.js.map
