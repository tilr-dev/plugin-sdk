/** A message handler the app registers (`webkit.messageHandlers.<name>`). */
export interface NativeHandler {
    postMessage(body: unknown): void;
}
declare global {
    interface Window {
        /** WebKit's bridge to the app: present in the Mac app's WKWebView only. */
        webkit?: {
            messageHandlers?: Record<string, NativeHandler | undefined>;
        };
    }
}
/** What the bridge needs of the page: its events and its WebKit handlers (`window` by default;
 *  an EventTarget with a fake `webkit` in a test). */
export type NativePage = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
    webkit?: Window['webkit'];
};
/** One native provider, as `describe()` lists them. */
export interface NativeProvider {
    id: string;
    version: string;
    channels: string[];
    events: string[];
}
/** What `connectNative()` returns. */
export interface NativeBridge {
    /** The native providers the app has. */
    describe(): Promise<NativeProvider[]>;
    /** Sends `message` to `plugin`'s `channel`; resolves when the app has dispatched it (results
     *  and state come back as the provider's events), rejects with the app's error or on timeout. */
    send(plugin: string, channel: string, message: Record<string, unknown>): Promise<{
        accepted: true;
    }>;
    /** Listens to a provider's event on the page (`'tilr-audio'`); returns the undo. */
    on(event: string, listener: (detail: Record<string, unknown>) => void): () => void;
    /** Rejects what is pending, removes every listener; the bridge refuses calls afterwards. */
    dispose(): void;
}
/**
 * The paired-plugin bridge (the app's `tilrNative` handler). Throws "Tilr native plugins are
 * unavailable" outside the app: check with `hasNative()` first for a web fallback. Dispose it
 * with the plugin: `ctx.effect(() => { const native = connectNative(); …; return () => native.dispose() })`.
 * `send()` acknowledges dispatch only; provider events carry state and results. The app's
 * control and automation services are never reachable through it.
 */
export declare function connectNative({ window: page, timeout }?: {
    window?: NativePage;
    timeout?: number;
}): NativeBridge;
/** True in the app, where `connectNative()` works. */
export declare function hasNative(page?: NativePage | undefined): boolean;
/** One of the app's per-service channels: what `nativeChannel()` returns. */
export interface NativeChannel<E> {
    /** Posts `body` to the app's handler. */
    post(body: unknown): void;
    /** Listens to the channel's event on the page (its `detail`); returns the undo. */
    listen(listener: (detail: E) => void): () => void;
}
/**
 * The app's handler `handler` (`'tilrAudio'`) and the event it answers with (`'tilr-audio'`), or
 * null when the page has no such handler (not in the app, or an app without it). Looked up now:
 * call it where the backend is chosen (a service's constructor).
 */
export declare function nativeChannel<E = unknown>(handler: string, event: string, page?: NativePage | undefined): NativeChannel<E> | null;
