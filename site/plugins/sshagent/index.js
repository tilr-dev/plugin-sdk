import { Service } from "cordis";
import { nativeChannel } from "tilr/native";
const HANDLER = "tilrAgent";
const EVENT = "tilr-agent";
const PROBE_TIMEOUT = 5e3;
const CHUNK = 64 * 1024;
function toBase64(bytes) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32768) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  }
  return btoa(binary);
}
function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function token() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
class Stream {
  id;
  post;
  onClose;
  listeners = /* @__PURE__ */ new Set();
  pending = [];
  ended = false;
  error;
  /** False until the app's 'open' (or the end). */
  opened = false;
  constructor(id, post, onClose) {
    this.id = id;
    this.post = post;
    this.onClose = onClose;
  }
  get closed() {
    return this.ended;
  }
  send(data) {
    if (this.ended || !(data instanceof Uint8Array) || data.length === 0) return;
    for (let at = 0; at < data.length; at += CHUNK) {
      this.post({ op: "data", id: this.id, data: toBase64(data.subarray(at, at + CHUNK)) });
    }
  }
  subscribe(listener) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      const pending = this.pending;
      this.pending = [];
      for (const bytes of pending) this.call(listener, bytes);
      if (this.ended) this.call(listener, null, this.error);
    } else if (this.ended) {
      this.call(listener, null, this.error);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
  close() {
    if (this.ended) return;
    this.post({ op: "close", id: this.id });
    this.end();
  }
  /** Bytes from the app. */
  receive(bytes) {
    if (this.ended) return;
    if (!this.listeners.size) {
      this.pending.push(bytes);
      return;
    }
    for (const listener of [...this.listeners]) this.call(listener, bytes);
  }
  /** The connection is over: `null` (and the error) to the listeners, once. */
  end(error) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    this.onClose(this);
    if (!this.listeners.size) return;
    for (const listener of [...this.listeners]) this.call(listener, null, error);
    this.listeners.clear();
  }
  call(listener, data, error) {
    try {
      if (data === null && error !== void 0) listener(null, error);
      else listener(data);
    } catch (e) {
      console.error(e);
    }
  }
}
class SshAgentService extends Service {
  static provide = "sshagent";
  static author = "dan";
  static tags = ["core"];
  static version = "0.1.14";
  static locked = true;
  constructor(ctx) {
    super(ctx, SshAgentService.provide);
    const channel = nativeChannel(HANDLER, EVENT);
    this.state = {
      post: channel ? (body) => channel.post(body) : null,
      available: false,
      path: null,
      error: null,
      probing: null,
      token: token(),
      next: 0,
      streams: /* @__PURE__ */ new Map(),
      opening: /* @__PURE__ */ new Map(),
      live: true
    };
    if (!channel) return;
    ctx.effect(() => {
      const off = channel.listen((event) => this.receive(ctx, event));
      void this.probe();
      return () => {
        off();
        this.state.live = false;
        this.state.probing?.resolve(false);
        this.state.probing = null;
        for (const { reject } of this.state.opening.values()) reject(new Error("sshagent: the service went"));
        this.state.opening.clear();
        for (const stream of [...this.state.streams.values()]) stream.close();
      };
    }, "sshagent: app events");
  }
  get available() {
    return this.state.available;
  }
  get path() {
    return this.state.path;
  }
  probe() {
    const { post } = this.state;
    if (!post || !this.state.live) return Promise.resolve(false);
    if (this.state.probing) return this.state.probing.promise;
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => {
      if (this.state.probing?.promise === promise) this.state.probing = null;
      resolve(this.state.available);
    }, PROBE_TIMEOUT);
    this.state.probing = { promise, resolve: (available) => {
      clearTimeout(timer);
      resolve(available);
    } };
    post({ op: "probe" });
    return promise;
  }
  async connect() {
    const caller = this.ctx;
    const { post } = this.state;
    if (!post) throw new Error("no SSH agent bridge: not the Mac app");
    if (this.state.probing) await this.state.probing.promise;
    if (!this.state.available) {
      throw new Error(this.state.error ? `no SSH agent socket found: ${this.state.error}` : "no SSH agent socket found");
    }
    const id = `${this.state.token}-${++this.state.next}`;
    const { streams, opening } = this.state;
    let release = null;
    const stream = new Stream(id, post, (closed) => {
      if (streams.get(closed.id) === closed) streams.delete(closed.id);
      opening.get(closed.id)?.reject(new Error("sshagent: the connection was closed before it opened"));
      opening.delete(closed.id);
      const drop = release;
      release = null;
      drop?.();
    });
    streams.set(id, stream);
    try {
      const off = caller.effect(() => () => {
        release = null;
        stream.close();
      }, "sshagent.connect()");
      if (!stream.closed) release = () => {
        void off();
      };
    } catch {
    }
    const opened = new Promise((resolve, reject) => opening.set(id, { resolve, reject }));
    post({ op: "open", id });
    await opened;
    return stream;
  }
  receive(ctx, detail) {
    if (!detail || typeof detail !== "object" || !this.state.live) return;
    switch (detail.type) {
      case "ready": {
        const available = !!detail.available;
        const path = available && typeof detail.path === "string" ? detail.path : null;
        this.state.error = available ? null : detail.error ?? null;
        const changed = available !== this.state.available || path !== this.state.path;
        this.state.available = available;
        this.state.path = path;
        const probing = this.state.probing;
        this.state.probing = null;
        probing?.resolve(available);
        if (changed) ctx.emit("sshagent/change");
        return;
      }
      case "open": {
        const stream = this.state.streams.get(detail.id);
        const waiting = this.state.opening.get(detail.id);
        this.state.opening.delete(detail.id);
        if (stream) stream.opened = true;
        waiting?.resolve();
        return;
      }
      case "data": {
        const stream = this.state.streams.get(detail.id);
        if (!stream || typeof detail.data !== "string") return;
        let bytes;
        try {
          bytes = fromBase64(detail.data);
        } catch {
          return;
        }
        stream.receive(bytes);
        return;
      }
      case "close": {
        const error = typeof detail.error === "string" ? detail.error : void 0;
        const waiting = this.state.opening.get(detail.id);
        this.state.opening.delete(detail.id);
        waiting?.reject(new Error(error ? `sshagent: ${error}` : "sshagent: the agent closed the connection"));
        this.state.streams.get(detail.id)?.end(error);
        return;
      }
    }
  }
}
var sshagent_default = SshAgentService;
export {
  EVENT,
  HANDLER,
  Stream,
  sshagent_default as default,
  fromBase64,
  toBase64
};
//# sourceMappingURL=index.js.map
