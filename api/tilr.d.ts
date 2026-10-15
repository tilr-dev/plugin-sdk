import { Service } from 'cordis';
import type { Context, Fiber } from 'cordis';
import type { ApplyResult, LayoutChange, LayoutChangeKind, PluginMeta, ServiceName, TilrPluginClass, TilrPluginObject, TilrServices } from './types.ts';
export type { AgentAdapter, ApplyResult, Audio, AudioFeatures, AudioPlayer, AudioState, AudioStatus, FiberStateName, FiberStates, Json, Layout, OpenRequest, OpenSource, PluginHost, PluginMeta, PluginModule, PluginRow, PluginState, Rect, ServiceDescription, ServiceName, SshAgent, SshAgentStream, Store, StoreArea, TilrGlobal, TilrPlugin, TilrPluginClass, TilrPluginObject, TilrServices, UI, Popup, UIAction, UIActOptions, UINode, UISnapshotOptions, UISnapshotWindow, UIWait, LayoutChange, LayoutChangeKind, FileTarget, Open, OpenHandler, OpenHandlerRow, OpenOptions, OpenTarget, UrlTarget, WebView, WebViewFeatures, WebViewOptions, WebViewProfile, WebViewProxy, WebViews, WebViewState, WindowField, WindowHandle, WindowMode, WindowRow, Windows, WindowSpec, WindowType, } from './types.ts';
/** The React build the page runs (build.mjs `--react`, $TILR_REACT): `dev` (development, the
 *  default), `profiling` (production with the profiler's hooks), `prod` (production, minified). */
export declare const reactMode: 'dev' | 'profiling' | 'prod';
/**
 * A point on the debug timeline: `mark('graph:loaded', { nodes: 120 })`. Recorded by the
 * shared Performance collector (`tilr ctl debug on`, `tilr ctl debug record`);
 * with debug off there is none, and this does nothing.
 */
export declare function mark(name: string, detail?: unknown): void;
/**
 * A span on the debug timeline, from `start` (a mark's name or a `performance.now()` time) to
 * `end` (the same; now when omitted): `const t = performance.now(); …; measure('graph:layout', t)`.
 * Does nothing with debug off, like `mark()`.
 */
export declare function measure(name: string, start: string | number, end?: string | number, detail?: unknown): void;
/** True while the Performance collector is on. Check it before computing anything costly for
 *  metric(). Cheap. */
export declare function collecting(): boolean;
/**
 * Records one observation of a metric. No-op (and no allocation) while not collecting.
 * name: dotted lowercase, e.g. 'server.decode'; value: a number (ms for durations, bytes, counts);
 * labels: small string map; 'chain' and 'hop' labels make the observation part of a pipeline
 * (hop = "NN-name", NN orders the hops, e.g. '30-build'), 'pane'/'window'/'plugin' identify the
 * subject; `end: '1'` on a chain metric without a hop marks the end-to-end measure (key → paint).
 * At most 512 series (name + labels) and 8 labels; label values that are not strings are ignored.
 *
 *   if (collecting()) metric('terminal.draw', performance.now() - t, { chain: 'terminal', hop: '50-draw', pane })
 */
export declare function metric(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
/** Adopts `sheet` into a document or shadow root; returns the undo. */
export declare function adopt(root: Document | ShadowRoot, sheet: CSSStyleSheet): () => void;
/**
 * The `theme` service: one CSSStyleSheet with the tokens (--bg, --accent, …) and the base
 * classes (.tile, button, …) that plugins style themselves with. The document adopts it
 * while the theme plugin is alive; shadow roots get it through `ctx.theme.attach(root)`.
 * A token's value, for what CSS cannot reach (a canvas), is `ctx.theme.token('--accent')`.
 */
export declare class Theme extends Service {
    /** The theme plugin's name ('theme', 'theme-light', …). */
    readonly variant: string;
    readonly sheet: CSSStyleSheet;
    constructor(ctx: Context, { name, sheet }: {
        name: string;
        sheet: CSSStyleSheet;
    });
    /**
     * A token's value as the theme sets it, trimmed ('' when it does not): `token('--bg')`. Read
     * off the root element, which is always rendered: an element's own computed style is stale
     * inside a hidden subtree (WebKit keeps a display: none tab's style from before a theme
     * switch). Plugins that inject `theme` are remounted on a switch, so a value read at mount
     * stays current.
     */
    token(name: string): string;
    /** Gives a shadow root the theme's classes. The effect belongs to the calling plugin. */
    attach(root: Document | ShadowRoot): void;
}
/**
 * Makes a theme plugin out of a CSS file: `export default theme(import.meta.url, './my.css')`.
 * The CSS is fetched (not imported) on every start, so saving it hot-reloads the theme; its
 * relative `url()`s (fonts, images next to it) are resolved against the file before adoption.
 * Only one theme runs at a time: the host switches the previous one off (see `provide`).
 * `meta` is merged into the plugin: `{ author, tags }` for the panel, `{ version, api, requires }`
 * for the version checks (a theme's `version` is what `requires: { theme: … }` is checked against).
 */
export declare function theme(base: string, css: string, meta?: Pick<PluginMeta, 'author' | 'tags' | 'version' | 'api' | 'requires'>): TilrPluginObject;
/** `ctx` with only the services in `I`: the others are not there until injected. */
export type InjectedContext<I extends ServiceName> = Omit<Context, ServiceName> & Pick<TilrServices, I>;
/**
 * Listens to 'layout/change', minus the kinds in `ignore`: a list that redraws on every change of
 * the windows but not when only a title changed is `onLayout(ctx, draw, { ignore: ['title'] })`.
 * The listener is an effect of `ctx`, like `ctx.on`'s: it leaves with the plugin (or the window's
 * scope); the function returned removes it sooner.
 */
export declare function onLayout(ctx: Pick<Context, 'on'>, listener: (change: LayoutChange) => void, options?: {
    ignore?: readonly LayoutChangeKind[];
}): () => boolean;
/**
 * Runs `apply` while the services it names exist, without making the plugin wait for them: an
 * optional dependency. A scope of its own (a cordis fiber) that starts when they are all there,
 * stops when one goes and starts again when it is back; what `apply` does through its `ctx`
 * (`ctx.on`, `ctx.effect`, a returned disposer) is undone each time, and with the plugin.
 * `ctx.inject(names, apply)` with the names checked against `TilrServices` and `ctx` narrowed
 * to them, as `definePlugin` does:
 *
 *   optional(ctx, 'menu', ctx => ctx.menu.contribute(target => …))
 *
 * A service of another plugin is typed by that plugin's published declarations: a dev
 * dependency on its repo (`"@tilr-dev/plugin-menu": "file:../menu"`) and a type-only import,
 * which the build erases: `import type {} from '@tilr-dev/plugin-menu/api'`. Returns the
 * scope; `dispose()` ends it sooner (a window's optional part, with the window).
 */
export declare function optional<K extends ServiceName>(ctx: Pick<Context, 'inject'>, services: K | readonly K[], apply: (ctx: InjectedContext<K>) => ApplyResult): Fiber & PromiseLike<Fiber>;
/**
 * Types a plugin without changing it. For the object form, `inject` takes the names in
 * `TilrServices`, and `ctx` has exactly those services: using one you did not inject is a type
 * error (at runtime cordis throws "cannot get property … without inject" for most of them).
 *
 *   export default definePlugin({ name: 'hello', inject: ['ui'], apply(ctx) { ctx.ui.tile() } })
 *
 * A class plugin is checked against `TilrPluginClass` and returned as is.
 *
 * `version` and `api` may be left out in a plugin built by `@tilr-dev/plugin/build`: the build
 * stamps its package.json's version and `^` + the `@tilr-dev/plugin` version it was built with,
 * and the runtime fills them in where the export has none (static fields on a class, too).
 */
export declare function definePlugin<I extends ServiceName = never>(plugin: Omit<TilrPluginObject, 'inject' | 'apply'> & {
    inject?: I[];
    apply(ctx: InjectedContext<I>): ApplyResult;
}): TilrPluginObject;
export declare function definePlugin<P extends TilrPluginClass>(plugin: P): P;
