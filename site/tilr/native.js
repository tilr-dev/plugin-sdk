function defaultPage() {
  return typeof window === "undefined" ? void 0 : window;
}
function detailOf(event) {
  return "detail" in event ? event.detail : void 0;
}
function record(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function connectNative({ window: page = defaultPage(), timeout = 1e4 } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("timeout must be positive");
  const handler = page?.webkit?.messageHandlers?.tilrNative;
  if (!page || !handler) throw new Error("Tilr native plugins are unavailable");
  const target = page;
  const pending = /* @__PURE__ */ new Map();
  const subscriptions = /* @__PURE__ */ new Set();
  const prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  let disposed = false;
  const reply = (event) => {
    const detail = record(detailOf(event));
    const finish = typeof detail?.id === "string" ? pending.get(detail.id) : void 0;
    if (detail && finish) finish(detail.error ? new Error(String(detail.error)) : null, detail.result);
  };
  target.addEventListener("tilr-native", reply);
  function request(body) {
    if (disposed) return Promise.reject(new Error("native bridge disposed"));
    const id = `${prefix}:${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("native bridge timed out")), timeout);
      function finish(error, value) {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      }
      pending.set(id, finish);
      try {
        handler?.postMessage({ ...body, id });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  return {
    describe: () => request({ op: "describe" }),
    send: (plugin, channel, message) => request({ op: "send", plugin, channel, message }),
    on(event, listener) {
      if (disposed) throw new Error("native bridge disposed");
      const receive = (e) => listener(record(detailOf(e)) ?? {});
      target.addEventListener(event, receive);
      const off = () => {
        target.removeEventListener(event, receive);
        subscriptions.delete(off);
      };
      subscriptions.add(off);
      return off;
    },
    dispose() {
      disposed = true;
      target.removeEventListener("tilr-native", reply);
      for (const off of [...subscriptions]) off();
      for (const finish of [...pending.values()]) finish(new Error("native bridge disposed"));
    }
  };
}
function hasNative(page = defaultPage()) {
  return !!page?.webkit?.messageHandlers?.tilrNative;
}
function nativeChannel(handler, event, page = defaultPage()) {
  const native = page?.webkit?.messageHandlers?.[handler];
  if (!page || !native) return null;
  const target = page;
  return {
    post: (body) => native.postMessage(body),
    listen(listener) {
      const receive = (e) => listener(detailOf(e));
      target.addEventListener(event, receive);
      return () => target.removeEventListener(event, receive);
    }
  };
}
export {
  connectNative,
  hasNative,
  nativeChannel
};
//# sourceMappingURL=native.js.map
