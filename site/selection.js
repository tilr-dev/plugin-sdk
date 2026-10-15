function sameSelection(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype) return false;
  const left = a, right = b;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameSelection(left[key], right[key]));
}
class SelectionHub {
  entries = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Set();
  delivering = false;
  subscribe(key, read, notify) {
    const keys = typeof key === "string" ? [key] : [...new Set(key)];
    const entry = { read, value: read(), notify, active: true };
    for (const key2 of keys) {
      let entries = this.entries.get(key2);
      if (!entries) this.entries.set(key2, entries = /* @__PURE__ */ new Set());
      entries.add(entry);
    }
    return () => {
      entry.active = false;
      for (const key2 of keys) {
        const entries = this.entries.get(key2);
        entries?.delete(entry);
        if (!entries?.size) this.entries.delete(key2);
      }
    };
  }
  notify(keys = this.entries.keys()) {
    for (const key of keys) this.pending.add(key);
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (this.pending.size) {
        const keys2 = [...this.pending];
        this.pending.clear();
        const entries = new Set(keys2.flatMap((key) => [...this.entries.get(key) ?? []]));
        for (const entry of entries) {
          if (!entry.active) continue;
          const next = entry.read();
          if (sameSelection(entry.value, next)) continue;
          entry.value = next;
          entry.notify();
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}
export {
  SelectionHub,
  sameSelection
};
//# sourceMappingURL=selection.js.map
