import type { Context, Effect } from 'cordis';
import type { Theme } from './tilr.ts';
/**
 * Every service a plugin can inject, by name: the page's own and the core plugins'; a plugin that
 * provides a service adds it here from its own file, next to its events:
 *
 *   declare module 'tilr' { interface TilrServices { counter: Counter } }
 *   declare module 'cordis' { interface Events { 'counter/change'(value: number): void } }
 *
 * cordis' `Context` extends this interface (below), so `ctx.counter` is typed everywhere, and
 * `definePlugin()` offers the names in `inject` and narrows `ctx` to the injected ones.
 */
export interface TilrServices {
    ui: UI;
    plugins: PluginHost;
    windows: Windows;
    layout: Layout;
    webviews: WebViews;
    audio: Audio;
    sshagent: SshAgent;
    store: Store;
    open: Open;
    theme: Theme;
}
/** The name of a service in `TilrServices`. */
export type ServiceName = keyof TilrServices & string;
/** What the panel reads off a plugin export (static fields on a class plugin). */
export interface PluginMeta {
    /** Grouping and `author:` search in the panel. */
    author?: string;
    /** Grouping and `tag:` search in the panel; a plugin is listed under each of its tags. */
    tags?: readonly string[];
    /** The service the plugin provides. The host runs one provider per service: switching one on
     *  switches the running one off (themes all provide 'theme'). */
    provide?: string;
    /** Services this plugin needs; cordis starts it only while all of them exist, and restarts it
     *  when one is replaced. An array of names, or a map name → intercept config. */
    inject?: (ServiceName | (string & {}))[] | Record<string, unknown>;
    /** Hides the on/off switch in the panel (the panel itself). */
    locked?: boolean;
    /** The plugin's own semver (`'1.4.0'`), shown in the panel. A provider's version is what
     *  other plugins' `requires` is checked against. Unset in a plugin built by
     *  `@tilr-dev/plugin/build`: the runtime fills in its package.json's version (the build's
     *  stamp); in-tree plugins use `__TILR_VERSION__`. */
    version?: string;
    /** The semver range of the tilr API the plugin was built against (`'^0.1.0'`), checked
     *  against `window.tilr.api` before it starts: on a mismatch it does not start and its state
     *  is 'incompatible'. Unset in a plugin built by `@tilr-dev/plugin/build`: `^` + the version
     *  of `@tilr-dev/plugin` it was built with (the build's stamp). Unset otherwise: no check. */
    api?: string;
    /** Service name → semver range on the `version` of the plugin that provides it
     *  (`{ counter: '^1.2.0' }`). Checked against the running provider before the plugin starts,
     *  and again whenever a provider starts; a missing or non-matching version makes the plugin
     *  'incompatible'. Waiting for a service is `inject`'s job: a range here does not inject it. */
    requires?: Partial<Record<ServiceName, string>> & Record<string, string>;
}
/** What `apply` may return: nothing, a promise (the plugin is 'loading' until it settles), or
 *  a disposer run on unload, e.g. `apply: ctx => ctx.on('plugins/change', render)`. */
export type ApplyResult = void | Promise<void> | Effect;
/** The object form: `export default { name, inject: ['ui'], apply(ctx) { ... } }`. */
export interface TilrPluginObject extends PluginMeta {
    name: string;
    /** Runs when the plugin starts (and again after each restart). Everything it does to the outside
     *  world must go through `ctx` (`ctx.effect`, `ctx.on`, `ctx.ui.tile`) so that disposing the
     *  plugin undoes it. May be async; the plugin is 'loading' until the promise settles. */
    apply(ctx: Context): ApplyResult;
}
/**
 * The class form: `export default class Counter extends Service { static provide = 'counter' }`.
 * The constructor plays the part of `apply`. Metadata are static fields. A class extending
 * `Service` becomes the service named by `static provide`; callers reach it through a proxy, so
 * keep mutable state in one holder object (`this.state = {...}`), not in own fields.
 */
export interface TilrPluginClass extends PluginMeta {
    new (ctx: Context): object;
    readonly name: string;
}
/** cordis' `FiberState` numbers, by index (`STATE[fiber.state]` in the runtime). The runtime's
 *  `STATE` array has this type, so names and order are checked against it. */
export type FiberStates = readonly ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'];
export type FiberStateName = FiberStates[number];
/** The default export of `plugins/<name>/index.ts`. */
export type TilrPlugin = TilrPluginObject | TilrPluginClass;
/** What `import()` of a plugin file must yield. */
export interface PluginModule {
    default: TilrPlugin;
}
/** A plugin's state in the panel: its fiber's state, 'failed' when its file did not import,
 *  'incompatible' when its `api` or `requires` does not match (it was not started), or 'off'
 *  when it is switched off (no fiber). */
export type PluginState = FiberStateName | 'incompatible' | 'off';
/** One row of `ctx.plugins.list()`: a plugin from plugins.json, its state and metadata. */
export interface PluginRow {
    name: string;
    author: string | null;
    tags: string[];
    /** The service it provides, if any. */
    provides: string | null;
    /** The services it injects (names only). */
    injects: string[];
    /** Not switched off (`localStorage['tilr-plugins-off']`). */
    enabled: boolean;
    locked: boolean;
    /** The plugin's `version` and `api` (see PluginMeta). */
    version: string | null;
    api: string | null;
    state: PluginState;
    /** Why the last import or start failed (the previous instance, if any, keeps running), or
     *  why it is incompatible. */
    error: Error | null;
    /** `Date.now()` of the last successful import. */
    loadedAt: number | null;
    /** How many controls without an accessible name its windows have shown since it started (the
     *  panel's `a11y` badge; the console has a warning for each). An agent still reaches them
     *  through `ctx.ui.snapshot()`, as `(unnamed)`, but cannot tell them apart. */
    unnamed: number;
    /** How many of its windows show an agent nothing (no text, no control, no `agent.text` on
     *  the type) a second after they mounted; counted in the same `a11y` badge. */
    blind: number;
}
/** A window's place on the canvas (`#grid`), in CSS pixels from its top left corner. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** Where a window lives: in the tree of splits that fills the canvas, floating over it, or
 *  inside another window (`nested`: a tab of a container; the parent says where it is drawn). */
export type WindowMode = 'tile' | 'float' | 'nested';
/**
 * What a plugin registers with `ctx.windows.register(type, …)`: how to show a window of that
 * type. The layout owns the windows (which are open, where); the type only draws one into the
 * element it is handed. `windowType()` in 'tilr/react' makes one out of a React component.
 */
export interface WindowType<C = unknown> {
    /** Draws the window into `host` (an empty element the size of the window) and returns the
     *  undo. Called when a window of this type opens, and again whenever the type is registered
     *  anew (the plugin reloaded) while the window is open; the undo runs when the window closes
     *  or the type goes away. `win` is the window: its config, mode and rect, and its controls. */
    mount(host: HTMLElement, win: WindowHandle<C>): void | (() => void);
    /** The title of a window that sets none: a string, or made from the window's config. Falls
     *  back to the type's name. */
    title?: string | ((config: C) => string);
    /** The config of a window opened without one. Must be JSON: it is saved with the window. */
    defaultConfig?: C;
    /** The mode a window opens in when the opener names none. Default 'tile'. */
    mode?: WindowMode;
    /** The modes a window of this type may be in. Default both. `['float']` for content of a fixed
     *  size (Winamp): the layout never tiles it (no tile request, drag or drop does), a window
     *  found tiled is floated at the type's size, and the frame shows no float / tile button. */
    modes?: WindowMode[];
    /** The size of a floating window opened without a rect. Default 480 × 320. */
    size?: {
        width: number;
        height: number;
    };
    /** Open once on first registration, or only on request ('never'). Manual closure persists.
     *  'always' is a deprecated alias for 'once' plus singleton, for older plugins. */
    open?: 'once' | 'always' | 'never';
    /** Reopening focuses the existing window instead of creating another instance. */
    singleton?: boolean;
    /** How an agent reads and drives a window whose content is not DOM (a terminal's grid on a
     *  canvas, a native view): `ctx.ui.snapshot()` shows its `text`, `ctx.ui.act(ref, 'fill')` on
     *  the window gives it `input`. Without one the window is read from its DOM. */
    agent?: AgentAdapter<C>;
}
/** How an agent sees and drives a window whose content is not DOM (a canvas grid, a native
 *  view). All optional; a window with none is read from its DOM as before. In the snapshot the
 *  window's content is a `document "<title>" [eN]` node: its text below it (the last lines), its
 *  actions as buttons, then whatever DOM the window has besides. */
export interface AgentAdapter<C = unknown> {
    /** What the window shows, as text (the screen, a log, a document). */
    text?(win: WindowHandle<C>): string;
    /** Text given to the window as a person would paste or type it; `fill` on the window's ref.
     *  A window that takes typed text (a terminal) should strip a trailing "\n" and send it as Enter. */
    input?(win: WindowHandle<C>, text: string): void | Promise<void>;
    /** Resolves when the window has settled, or when `until` (multiline) matches its text. `act`'s
     *  `wait` calls it after the action; it gives up after `timeoutMs` (resolving later or
     *  rejecting is a timeout). The adapter may resolve on its own timeout: with an `until` the
     *  runtime checks the text itself, no match being a timeout; without one a resolve is settled.
     *  Without a `wait`, the runtime watches the window's DOM and `text`. */
    wait?(win: WindowHandle<C>, until?: RegExp, options?: {
        idleMs: number;
        timeoutMs: number;
    }): Promise<void>;
    /** Verbs the window offers beyond input: shown in the snapshot as buttons `→ <type>.<name>`,
     *  called by `act(ref, 'click')`. */
    actions?: Record<string, (win: WindowHandle<C>) => unknown>;
}
/** `ctx.windows`: the window types the running plugins register, by name. */
export interface Windows {
    /** Registers `type` while the calling plugin lives (an effect: unload removes it). Throws if
     *  the name is taken: two plugins cannot register the same type. */
    register<C>(type: string, definition: WindowType<C>): void;
    /** The definition registered under `type`, if any. */
    get(type: string): WindowType | undefined;
    /** The registered type names, in registration order. */
    list(): string[];
}
/** What `ctx.layout.open()` takes. */
export interface WindowSpec {
    type: string;
    /** JSON, saved with the window; the type's `defaultConfig` when unset. */
    config?: unknown;
    /** Overrides the type's title. */
    title?: string;
    /** The type's `mode` when unset. Ignored with `parent`. */
    mode?: WindowMode;
    /** Where a floating window goes; missing fields are filled in (cascaded position, the type's size). */
    rect?: Partial<Rect>;
    /** Not saved across page loads: the window belongs to its opener, which closes it (what
     *  `ctx.ui.tile()` opens). */
    transient?: boolean;
    /** Opens the window inside this one (a container: a tabs window). The parent draws it where it
     *  likes (`WindowHandle.place`); the window is a full window of the layout all the same.
     *  Ignored when no such window is open. */
    parent?: string;
}
/** Who asks for a window (`ctx.layout.open(spec, { from })`): what a container matches its
 *  openers by. `window` is the opener's own window (a window type's `win.id`), null for a plugin
 *  without one (a service). */
export interface OpenSource {
    plugin: string;
    window: string | null;
}
/** The payload of 'window/open'. */
export interface OpenRequest {
    spec: WindowSpec;
    from: OpenSource;
}
/** One open window, a row of `ctx.layout.list()`. */
export interface WindowRow {
    id: string;
    type: string;
    title: string;
    config: unknown;
    mode: WindowMode;
    /** The modes it may be in (the type's `modes`). */
    modes: WindowMode[];
    /** Its place now (canvas coordinates): computed from the tree of splits for a tile, its own
     *  for a float, the element its parent placed it in for a nested window (zero until placed). */
    rect: Rect;
    focused: boolean;
    /** Whether its type is registered right now; a window whose type is away shows a placeholder. */
    mounted: boolean;
    transient: boolean;
    /** The window this one is nested in, if any. */
    parent: string | null;
    /** The windows nested in this one, in the order they came in (opened in it, or adopted). */
    children: string[];
}
/** What 'layout/change' carries: nothing for a change of the windows (opened, closed, moved,
 *  mode, focus, config), `{ kind: 'title', id }` when only a title changed. `onLayout()` (from
 *  'tilr') filters by `kind`. */
export type LayoutChange = {
    kind: 'title';
    id: string;
} | undefined;
/** The kinds of a 'layout/change' that says what changed. */
export type LayoutChangeKind = NonNullable<LayoutChange>['kind'];
/** The window as its type's `mount` sees it: what it is, where it is, and what it may ask of the
 *  layout. The layout decides where a window goes; the window may only request. */
export type WindowField = 'title' | 'type' | 'config' | 'mode' | 'modes' | 'rect' | 'focused' | 'parent' | 'children';
export interface WindowHandle<C = unknown> {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly config: C;
    readonly mode: WindowMode;
    /** The modes it may be in (the type's `modes`): a request for another is ignored. */
    readonly modes: WindowMode[];
    readonly rect: Rect;
    readonly focused: boolean;
    /** The window this one is nested in, if any. */
    readonly parent: string | null;
    /** The windows nested in this one (a container's tabs), in opening order, as the layout lists
     *  them: title, config, `focused` (the one the user is in). */
    readonly children: WindowRow[];
    /** The config to save with the window (what must survive a reload goes here). */
    setConfig(config: C): void;
    setTitle(title: string): void;
    /** Asks to float, at `rect` (missing fields: where the window is now). Out of a container too. */
    requestFloat(rect?: Partial<Rect>): void;
    /** Asks to go back into the tree of splits. Out of a container too. */
    requestTile(): void;
    focus(): void;
    close(): void;
    /** Where a nested window is drawn: the layout renders the child's window into `host` (an
     *  element of this window's content, emptied first) and mounts its type there. A container
     *  calls it for every child it shows, from `mount` and whenever `children` changes; hide a
     *  tab by hiding its host (the content stays mounted, a terminal keeps its screen). `null`
     *  takes the child out of the page (its content unmounts). A child with no place is not drawn. */
    place(childId: string, host: HTMLElement | null): void;
    /** Without fields, observes every layout change (legacy). With fields, observes only
     * changed selected values of this window. Returns cleanup. Configs must be replaced,
     * not mutated in place. Older layout providers may ignore fields. */
    subscribe(listener: () => void, fields?: readonly WindowField[]): () => void;
}
/**
 * `ctx.layout`: the window manager, a plugin that provides 'layout' and owns the canvas. Windows
 * are its state (saved in the page, so they survive a reload of the page and of the plugins that
 * draw them); types are the plugins'. One layout runs at a time; without one, `ctx.ui.tile()`
 * falls back to a plain grid. Every change emits `layout/change`.
 */
export interface Layout {
    /** Opens a window and returns its id. With `from` (and no `spec.parent`) the request goes
     *  through the bus first: a container claiming 'window/open' opens the window inside itself
     *  and its id is returned; unclaimed, the window opens on the canvas as without `from`. */
    open(spec: WindowSpec, options?: {
        from: OpenSource;
    }): string;
    close(id: string): void;
    /** Takes the window out of the tree and floats it at `rect` (missing fields: where it is now).
     *  Ignored for a type whose `modes` exclude 'float'. */
    float(id: string, rect?: Partial<Rect>): void;
    /** Puts a floating (or nested) window back into the tree, next to the focused tile. Ignored
     *  for a type whose `modes` exclude 'tile'. */
    tile(id: string): void;
    /** Moves the window into `parent` (a container), out of the tree or off the floats. Ignored
     *  when either is missing, or `parent` is the window or one nested in it. */
    adopt(id: string, parent: string): void;
    focus(id: string): void;
    setTitle(id: string, title: string): void;
    setConfig(id: string, config: unknown): void;
    get(id: string): WindowRow | undefined;
    /** Every open window, in opening order. */
    list(): WindowRow[];
}
/** `ctx.ui`: tiles and stylesheets that leave with the calling plugin, and the page as an agent
 *  sees it (`snapshot`) and drives it (`act`). */
export interface UI {
    /** Opens a window for the plugin and returns its body element; the window closes on unload.
     *  `title` defaults to the plugin's name. With a layout running the window is the layout's
     *  (it tiles, floats, moves); without one it is a tile in a plain grid. */
    tile(options?: {
        title?: string;
    }): HTMLElement;
    /** Adopts `css` into the document while the plugin lives. Use the theme's tokens
     *  (`var(--accent)`), never literal colors. */
    style(css: string): void;
    /**
     * Marks `element` as drawn over everything (a menu, a dropdown, a tooltip), native web views
     * included: while it is shown, every view leaves its rect to the page (a hole the mouse goes
     * through). Show and hide it by its size (`hidden`, `display: none`), which is what is
     * watched: a change of `visibility` or `opacity` alone is not seen. Leaves with the plugin;
     * the function returned unmarks it sooner. `popup()` does this itself. An element appended to
     * `<body>` and positioned (`fixed`, `absolute`) is seen over the views without the mark; the
     * mark is for a nested one (inside a tile, the header, a shadow root).
     */
    overlay(element: HTMLElement): () => void;
    /** The elements marked with `overlay()`, shown or not. A change is told as `ui/overlay`. */
    overlays(): HTMLElement[];
    /**
     * Makes `element` a popup (a menu, a dropdown): hidden until `open()`, closed by a press
     * outside it and `anchor` (the control that toggles it), Escape, or the page losing the focus,
     * and marked with `overlay()`. Where it shows is the plugin's CSS; the element stays where the
     * plugin put it (its shadow root, its styles). Leaves with the plugin, closed. A panel of your
     * own appended to `<body>` and positioned shows over a browser without it.
     */
    popup(element: HTMLElement, options?: {
        anchor?: HTMLElement;
    }): Popup;
    /**
     * The open windows as an accessibility tree: every visible control (named or not), heading,
     * status and short text, each element with a ref (`e12`) that `act` takes. Text by default,
     * one line per node, in the style of Playwright's aria snapshot:
     *
     *   window w3 "server" (server, tile, focused)
     *     textbox "Server URL" = "ws://127.0.0.1:7890" [e5]
     *     button "Save" [e10] → server.update
     *
     * `role "name" = "value" [state…] [ref] → data-call`; a control without a name ends in
     * `(unnamed)`. A ref stays the element's while the element lives. A window whose type has
     * `agent` (AgentAdapter) shows its content as a document, its text's last `lines` below it
     * and its actions as buttons:
     *
     *   window w5 "zsh" (terminal, tile, focused)
     *     document "zsh" [e7] =
     *       | … (120 more lines)
     *       | $ ls
     *       button "clear" [e8] → terminal.clear
     */
    snapshot(options?: UISnapshotOptions & {
        format?: 'text';
    }): string;
    snapshot(options: UISnapshotOptions & {
        format: 'json';
    }): UISnapshotWindow[];
    /**
     * Does to the element `ref` what a person would, through real DOM events (the plugin's own
     * handlers run, nothing else does), waits two frames for the page to redraw and resolves to
     * the snapshot of the window it is in (text by default; null when there is no window at all).
     * Throws when the ref is gone (`take a new snapshot`), the element is disabled, or the action
     * does not fit it. `value`: the text for 'fill', the option's value or text for 'select', the
     * key for 'press' (`'Enter'`, `'Escape'`, `'a'`, `'Meta+k'`; ref `''` presses on the focused
     * element). 'fill' on a window's document (a type with `agent.input`) gives it the text.
     * `options.wait`: after the action, until the window settles or its text matches `until`
     * (UIWait); a timeout is no error, the snapshot ends in `(wait: timed out after N ms)`.
     */
    act(ref: string, action: UIAction, value?: string, options?: UIActOptions & {
        format?: 'text';
    }): Promise<string>;
    act(ref: string, action: UIAction, value: string | undefined, options: UIActOptions & {
        format: 'json';
    }): Promise<UISnapshotWindow | null>;
}
/** What `ctx.ui.popup()` returns. */
export interface Popup {
    readonly element: HTMLElement;
    readonly opened: boolean;
    open(): void;
    close(): void;
    toggle(): void;
    /** Called after it opens or closes; returns the unsubscribe. */
    subscribe(listener: (opened: boolean) => void): () => void;
}
/** What `ctx.ui.snapshot()` takes. */
export interface UISnapshotOptions {
    /** A window's id (`ctx.layout.list()`; the type's name for a tile without a layout). All
     *  windows when unset. */
    window?: string;
    format?: 'text' | 'json';
    /** How many lines of a document's text (AgentAdapter.text) are shown: the last ones, after
     *  `… (N more lines)`. Default 40. */
    lines?: number;
}
/** What `ctx.ui.act()` takes besides the format. */
export interface UIActOptions {
    /** After the action, wait for the window (UIWait) before the snapshot. */
    wait?: UIWait;
    /** As for `snapshot`: the lines of a document's text shown. Default 40. */
    lines?: number;
}
/** `act`'s wait: the window's `agent.wait` when its type has one; else until the window is quiet
 *  for `idleMs` (no mutation of its DOM, no change of its text, read every 100 ms), or as soon as
 *  `until` matches its text (`agent.text`, else the DOM's text; line ends trimmed, blank lines at the
 *  end left out). */
export interface UIWait {
    /** A regular expression's source, compiled multiline (`^` / `$` match at each line), matched
     *  against the window's text with each line trimmed at its end (a `$ ` prompt is `\$$`). */
    until?: string;
    /** Default 300. */
    idleMs?: number;
    /** Default 10000. Reaching it is no error. */
    timeoutMs?: number;
}
/** One node of a snapshot. */
export interface UINode {
    /** `e12`: what `act` takes. Stable while the element lives. '' for a run of text. */
    ref: string;
    /** The computed role: button, link, textbox, combobox, checkbox, radio, switch, slider,
     *  option, tab, menuitem, heading, status, img, listitem, group, text … */
    role: string;
    /** The accessible name: aria-label, aria-labelledby, its <label>, its text (up to 80
     *  characters), placeholder, title; '' when it has none. */
    name: string;
    /** A field's value (a password's is `•••`), a select's chosen option's text. */
    value?: string;
    /** 'checked' | 'unchecked' | 'mixed' | 'disabled' | 'focused' | 'selected' | 'expanded' |
     *  'collapsed' | 'readonly' | 'pressed' | 'current'. */
    state?: string[];
    /** The element's `data-call`: the service method the control stands for (`server.update`);
     *  for an AgentAdapter's action, `<type>.<name>`. */
    call?: string;
    /** A document's text (AgentAdapter.text): its last lines, a `… (N more lines)` line first
     *  when cut. */
    text?: string;
    children?: UINode[];
}
/** One window of a snapshot. */
export interface UISnapshotWindow {
    id: string;
    type: string;
    title: string;
    mode: WindowMode;
    focused: boolean;
    /** The window it is nested in (a tab of a container). */
    parent?: string;
    /** Open, but not drawn (a container's hidden tab): no nodes. */
    hidden?: boolean;
    /** It closed during the `act` (its close button). */
    closed?: boolean;
    /** The `act`'s wait gave up: after how many milliseconds. */
    timedOut?: number;
    nodes: UINode[];
}
/** What `ctx.ui.act()` does to an element. */
export type UIAction = 'click' | 'dblclick' | 'fill' | 'select' | 'check' | 'uncheck' | 'focus' | 'press' | 'scroll';
/** What `window.tilr.describe()` says about a running service. */
export interface ServiceDescription {
    name: string;
    /** The plugin that provides it (`'runtime'` for ui, plugins and windows), null if unknown. */
    plugin: string | null;
    /** The provider's version (the page's API version for the runtime's). */
    version: string | null;
    /** Its methods, own and inherited (up to cordis' Service), without `_`-prefixed ones;
     *  `arity` is the function's `length` (optional parameters do not count). `internal`: not
     *  in the contract (the service's interface in its declarations); callable all the same, but
     *  it may change. Nothing is marked when there is no contract. */
    methods: {
        name: string;
        arity: number;
        internal?: true;
    }[];
    /** The service is a function too (`ctx.open(target)`): `$.open(…)`, `tilr ctl call open …`. */
    callable?: true;
    /** Its other public members: fields and getters, `internal` as for the methods. */
    fields: {
        name: string;
        internal?: true;
    }[];
    /** The provider's declarations (`api.d.ts` next to its index.js; the page's API for the
     *  runtime's services), when one service is asked for and the file exists; null otherwise.
     *  The contract the members are marked against comes from the same file, asked for or not. */
    api: string | null;
}
/** What a web view reports about the page it shows. */
export interface WebViewState {
    /** The page's URL now (the one asked for until the first report comes back). */
    url: string;
    /** The page's title; empty until it has one. */
    title: string;
    loading: boolean;
    /** 0 … 1, the load's progress; 1 when idle. */
    progress: number;
    canGoBack: boolean;
    canGoForward: boolean;
    /** Why the last load failed, or null. */
    error: string | null;
    /** The proxy of the view's profile, on the native backend; unset without one. `error`: the
     *  tunnel's last failed handshake (`'401 bad token'`, `'404 no SOCKS on this server'`,
     *  `'502 …'`), gone after the next one that goes through. A socks5 or http proxy has none:
     *  WebKit does not tell. */
    proxy?: {
        kind: WebViewProxy['kind'];
        error?: string;
    };
    /** The native backend released the view's web content: it was hidden (not visible, covered,
     *  off-screen, or parked) for `browser.discard_after` seconds. Its last picture stays in
     *  place; shown again (or navigated, or driven by automation) it loads its page again with
     *  its history and scroll, script state lost, and this goes back to false. Unset on the
     *  iframe backend. */
    discarded?: boolean;
}
/** A proxy for a profile's views. `'socks5'` and `'http'` (HTTP CONNECT): a proxy server, with
 *  a username and password if it asks for them. `'tunnel'`: a tilr server's `/socks` endpoint
 *  (`url` is its `wss://…/socks`, `token` the server's access token), which the app bridges.
 *  `match`: only these hosts and their subdomains go through the proxy, the rest direct (unset:
 *  every host). `exclude`: these hosts and their subdomains go direct. Literal `localhost`,
 *  `127.*` and `[::1]` never go through a proxy (WebKit's rule); a `<name>.localhost` host does,
 *  and a tilr server takes it for its own loopback. */
export type WebViewProxy = {
    kind: 'socks5' | 'http';
    host: string;
    port: number;
    user?: string;
    pass?: string;
    match?: string[];
    exclude?: string[];
} | {
    kind: 'tunnel';
    url: string;
    token: string;
    match?: string[];
    exclude?: string[];
};
/** A profile: the views made with it share one cookie jar and storage, apart from every other
 *  profile's and from the default one (no profile). `id` is a UUID, the same across runs: it
 *  names the storage. `proxy`: where the profile's connections go. `localhost`: the host a
 *  navigation to `localhost`, `127.*` or `[::1]` goes to instead (`pb.localhost`: the proxy's own
 *  loopback, by the tilr server's rule), port, path and query kept; unset: no rewrite. Only the
 *  native backend has profiles (`features`). */
export interface WebViewProfile {
    id: string;
    proxy?: WebViewProxy;
    localhost?: string;
}
/** What `ctx.webviews.create()` takes. */
export interface WebViewOptions {
    url: string;
    /** The page asks for a new window (`target=_blank`, `window.open`): the caller opens one.
     *  Unset: the view loads the URL in place. Only the native backend reports it. */
    onOpen?: (url: string) => void;
    /** The view's profile: its storage and its proxy. Unset: the default one. The iframe backend
     *  takes it and leaves it (the frame is the page's browser's). */
    profile?: WebViewProfile;
    /** A name of the view stable across reloads of the page (a window's id). The native backend
     *  keeps the view of a page that reloads, by its key, for `browser.adopt_grace` seconds; a
     *  view of the new page created with the same key and profile gets it back (`adopted`): the
     *  same page, scroll, forms and script state, nothing loaded again, `url` ignored (the live
     *  view is at least as recent as what the page saved). Unset: a new view every time. The
     *  iframe backend takes it and leaves it. */
    key?: string;
}
/** What a backend of the web views can do. */
export interface WebViewFeatures {
    /** Storage apart per `profile`. */
    readonly profiles: boolean;
    /** A profile's `proxy`. */
    readonly proxy: boolean;
}
/**
 * One web view, drawn over `host`: a browser's content area. The native backend (the Mac app)
 * draws a WKWebView of its own at the host's place on screen, so it loads any site and reports
 * its URL, title and history; it sits above the page, so what the page draws over the host
 * (a floating window, a menu) is hidden by it. The iframe backend (the page in a plain browser)
 * puts an `<iframe>` into the host: a site that forbids framing does not load, and a foreign
 * page's title, URL and history are not readable, so `title` stays empty, `url` is what was
 * asked for, and `back` / `forward` do nothing.
 */
export interface WebView extends Readonly<WebViewState> {
    readonly id: string;
    /** The native backend gave this view the live view of the page before a reload (the same
     *  `key`): its state came from it, not from `url`. False until the backend says so. */
    readonly adopted: boolean;
    navigate(url: string): void;
    back(): void;
    forward(): void;
    reload(): void;
    stop(): void;
    /** Calls `listener` after every change of the state; returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** Takes the view down. Also what unloading the creating plugin does. */
    dispose(): void;
}
/** `ctx.webviews`: web views (a browser's content) placed over elements of the page. Provided
 *  by the `webviews` plugin, which picks the backend the shell offers. */
export interface WebViews {
    /** 'native' in the Mac app (a WKWebView per view), 'iframe' anywhere else. */
    readonly backend: 'native' | 'iframe';
    /** What the backend can do: native, everything; iframe, neither profiles nor proxies. */
    readonly features: WebViewFeatures;
    /** Opens a view over `host` (the view follows the element: its place, its size, hidden with
     *  it). It leaves with the calling plugin. */
    create(host: HTMLElement, options: WebViewOptions): WebView;
    /** The open views, in creation order. */
    list(): WebView[];
}
/** Where a player is: 'stopped' (at 0, or never started), 'playing', 'paused' (where it was). */
export type AudioStatus = 'stopped' | 'playing' | 'paused';
/** What a player reports. */
export interface AudioState {
    status: AudioStatus;
    /** The track loaded, or null before the first `load()`. */
    url: string | null;
    /** Seconds into the track. Cheap to read: while playing it moves on its own (the web backend
     *  reads the element, the native one interpolates from the app's last report), and no change
     *  of it alone is told to the listeners: poll it (on a frame, a timer) while playing. */
    position: number;
    /** Seconds; 0 until known (a stream that never says stays 0). */
    duration: number;
    /** Waiting for data while it should be playing (buffering). */
    stalled: boolean;
    /** 0 … 1. Default 1. */
    volume: number;
    /** -1 (left) … 1 (right). Default 0. */
    balance: number;
    /** The equalizer, Winamp's: `preamp` and the 10 `bands` (60, 170, 310, 600, 1k, 3k, 6k, 12k,
     *  14k, 16k Hz) in dB, -12 … 12. Default off, all 0. */
    eq: {
        enabled: boolean;
        preamp: number;
        bands: number[];
    };
}
/** What a backend does besides playing: the native one (v1) neither equalizes, pans nor
 *  analyses, though `setEq` / `setBalance` are still kept in the state. */
export interface AudioFeatures {
    eq: boolean;
    balance: boolean;
    analyser: boolean;
}
/**
 * One player, named by `key`: a track, its transport and its sound. It belongs to the `audio`
 * service, not to the plugin that asked for it: unloading or reloading that plugin (or the
 * `audio` plugin itself) does not stop it; only `dispose()` does. The plugin finds it again
 * with `ctx.audio.player(key)`. Listeners (`subscribe`, `on`) are the caller's: they leave with
 * the plugin that added them, and the returned function removes one earlier.
 */
export interface AudioPlayer extends Readonly<AudioState> {
    readonly key: string;
    /** Replaces the track: status 'stopped', position 0, duration 0 until known. `meta` is for the
     *  system's Now Playing (native); the web backend ignores it. */
    load(url: string, meta?: {
        title?: string;
        artist?: string;
    }): void;
    /** From where it is (0 when stopped). Does nothing before a `load()`. */
    play(): void;
    pause(): void;
    /** Pause, and back to 0. */
    stop(): void;
    /** Seconds, clamped to the track. */
    seek(seconds: number): void;
    setVolume(volume: number): void;
    setBalance(balance: number): void;
    /** Merges into `eq` (a partial `bands` array is not merged: pass all 10). */
    setEq(eq: Partial<AudioState['eq']>): void;
    /** The web backend's output, before the volume (a visualizer's input); null on the native
     *  backend (`features.analyser` false). */
    analyser(): AnalyserNode | null;
    /** Calls `listener` after every change of the state but the position moving on its own:
     *  status, url, duration, stalled, volume, balance, eq, and a seek. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** 'ended': the track played to its end (status is now 'stopped', position 0). 'error':
     *  `{ message }`, the track could not be loaded or played (status 'stopped' or 'paused').
     *  'command': `{ command: 'next' | 'previous' }`, a media key the player cannot do itself
     *  (native only; play / pause keys the app handles and reports as state). Returns the off. */
    on(event: 'ended' | 'error' | 'command', callback: (detail?: unknown) => void): () => void;
    /** Stops the player and forgets it: `player(key)` makes a new one. */
    dispose(): void;
}
/**
 * `ctx.audio`: playback that outlives the plugins that use it (a player plugin is reloaded on
 * every edit; the music goes on). Provided by the `audio` plugin. Two backends: 'native' in the
 * Mac app, the players are the app's (AVPlayer) and survive even a reload of the page; 'web'
 * anywhere else, an `<audio>` element through Web Audio, kept on `globalThis` so that a reload of
 * the `audio` plugin re-adopts it (a page reload ends it).
 */
export interface Audio {
    readonly backend: 'native' | 'web';
    readonly features: AudioFeatures;
    /** The player named `key`: the live one if there is one (made by an earlier incarnation of the
     *  calling plugin, or before a page reload on the native backend), else a new one, stopped,
     *  with no track. Not an effect of the caller: the player stays when the caller goes. */
    player(key: string): AudioPlayer;
    /** The live players. */
    players(): AudioPlayer[];
}
/**
 * One connection to the local SSH agent, opened by `ctx.sshagent.connect()`. It is the caller's:
 * it closes when the plugin that opened it goes. Bytes go both ways as they come; the agent
 * protocol's framing is the caller's business.
 */
export interface SshAgentStream {
    /** Bytes to the agent. Nothing once closed. */
    send(data: Uint8Array): void;
    /** Bytes from the agent, in order; `null` once when the connection is over (`error` says why
     *  if it failed). Bytes that arrive before the first subscriber wait for it, and a subscriber
     *  added after the end gets the `null` at once. Returns the unsubscribe. */
    subscribe(listener: (data: Uint8Array | null, error?: string) => void): () => void;
    /** Closes the connection; subscribers get the `null`. */
    close(): void;
    readonly closed: boolean;
}
/**
 * `ctx.sshagent`: the user's local SSH agent socket, reachable through the Mac app (its
 * `tilrAgent` message handler), for a plugin to forward it (to a tilr server's panes, like
 * `ssh -A`). Provided by the `sshagent` plugin. No fallback: in a browser the service is there
 * with `available` false, so a plugin can inject it unconditionally. Emits `sshagent/change`
 * when `available` or `path` changes. Whatever the page forwards the agent to can ask it for
 * signatures (the agent prompts if it is configured to).
 */
export interface SshAgent {
    /** Whether a local agent is reachable through the app: false in a browser, or with no agent
     *  socket found. */
    readonly available: boolean;
    /** Where the app found it, for the UI. */
    readonly path: string | null;
    /** Asks the app again (the socket may have appeared); resolves to `available`. */
    probe(): Promise<boolean>;
    /** Opens a connection to the agent. Rejects when not available (the message says why), or
     *  when the app cannot open the socket. */
    connect(): Promise<SshAgentStream>;
}
/** A value the store keeps: what JSON can say. */
export type Json = string | number | boolean | null | Json[] | {
    [key: string]: Json;
};
/**
 * `ctx.store`: a key-value store with one interface and a backend the service picks: 'local'
 * (the page's localStorage) now; 'app' (the Mac app's, through a message handler) and 'cloud'
 * (Tilr Cloud) later. Provided by the `store` plugin. Reads and writes are synchronous, over a
 * cache the backend fills before the service is provided: a plugin that injects `store` never
 * sees it unloaded.
 */
export interface Store {
    /** The backend in use: 'local' now; 'app' and 'cloud' later. */
    readonly backend: string;
    /** A namespace of keys, `name` is the plugin's (or any stable name; no dots). With `secure`,
     *  values go where the backend keeps secrets (a Keychain, encrypted cloud storage); the local
     *  backend keeps them in localStorage like the rest: the flag is the caller's declaration. */
    area(name: string, options?: {
        secure?: boolean;
    }): StoreArea;
    /** Everything the backend holds: area → key → value, the areas no plugin opened yet included
     *  (an opened area's values as its cache has them), secure ones too. What `tilr app export`
     *  writes as a template's store.json. A fresh page (no `tilr.*` key in localStorage) is seeded
     *  from the file the site's plugins.json names as `store` (`"store": "store.json"`), once,
     *  before the service is provided. */
    dump(): Record<string, Record<string, Json>>;
}
/** One area of the store: keys to JSON values. */
export interface StoreArea {
    readonly name: string;
    /** The value, or undefined when the key is unset. The same object until the key changes:
     *  do not mutate it, `set` a new one. */
    get<T extends Json = Json>(key: string): T | undefined;
    /** Stores a copy (the value as JSON says it: an undefined field is dropped). Setting what the
     *  key already holds changes nothing. A write the backend refuses (private mode, quota) keeps
     *  the value for this page and warns. */
    set(key: string, value: Json): void;
    delete(key: string): void;
    /** The keys set in the area. */
    keys(): string[];
    /** Called when a key changes: by this page, by another tab (the window's `storage` event),
     *  later by another device. `key` null watches the whole area. A change by the caller itself
     *  is reported too. The listener leaves with the plugin that added it; the returned function
     *  removes it earlier. */
    watch(key: string | null, listener: (key: string, value: Json | undefined) => void): () => void;
}
/** A file on a tilr server: `server` is the server's profile id, `path` absolute on that host.
 *  `text` and `language`: its content and language when the opener has them (a file browser
 *  that read it); a handler that needs the content and finds no `text` cannot open it. */
export interface FileTarget {
    kind: 'file';
    server: string;
    path: string;
    mime?: string;
    text?: string;
    language?: string;
}
/** A web address. */
export interface UrlTarget {
    kind: 'url';
    url: string;
}
/** What `ctx.open()` opens: a file, a URL, or a kind of a plugin's own (`{ kind: 'issue', id }`).
 *  The service checks the fields of 'file' and 'url' (it throws on a file without a `path`), so
 *  a handler that has seen `kind === 'file'` may take the target as a `FileTarget`. */
export type OpenTarget = FileTarget | UrlTarget | {
    kind: string;
    [key: string]: unknown;
};
/** What a plugin registers with `ctx.open.register()`: something it can open things in. */
export interface OpenHandler {
    /** The plugin it belongs to; the registering plugin's name when unset. */
    plugin?: string;
    /** Shown in "Open with…" (`'Editor'`, `'Browser'`). With `plugin`, the handler's id
     *  (`editor/Editor`): one plugin may register several under different names. */
    name: string;
    /** How well it handles `target`: 0 (or less) not at all, 1 a fit, more a better one; a
     *  generic fallback scores below 1. Only handlers above 0 are offered. Synchronous and cheap:
     *  it runs for every open. */
    match(target: OpenTarget): number;
    /** Opens `target` and resolves to the window it opened (or focused), or undefined when it
     *  cannot after all (a file target without the `text` it needs). `from` is the opener: pass it
     *  on to `ctx.layout.open(spec, { from })`, so a container can take the window in. */
    open(target: OpenTarget, from: OpenSource): string | undefined | Promise<string | undefined>;
}
/** A registered handler, as `ctx.open.handlers()` lists it. */
export interface OpenHandlerRow {
    /** `plugin/name`: what `ctx.open(target, { handler })` takes. */
    id: string;
    plugin: string;
    name: string;
    /** Its `match` of the target asked about; absent when no target was given. */
    score?: number;
    /** It is the remembered choice for the target's kind and extension (or host). */
    default?: true;
}
/** What `ctx.open(target, options)` takes. */
export interface OpenOptions {
    /** The opener; `{ plugin: <the caller>, window: null }` when unset. */
    from?: OpenSource;
    /** A handler's id (`editor/Editor`) or plugin name (`editor`): open with it, no choice asked,
     *  nothing remembered. The route for an agent (`handlers(target)` lists the candidates). */
    handler?: string;
    /** Ask "Open with…" even when a choice is remembered (or only one handler fits). */
    ask?: boolean;
}
/**
 * `ctx.open`: opens things where they are best shown, the handlers being the plugins'. A file
 * browser opens a file without knowing the editor, the editor registers for text files, a
 * browser for URLs. Provided by the `open` plugin.
 *
 * `ctx.open(target, options)` asks every handler's `match`: none above 0 resolves to undefined;
 * one opens it; several open the remembered choice for the target's key (`file:.ts`,
 * `url:github.com`, `issue:*`) if it is among them, else show an "Open with…" popup listing them,
 * best first, whose pick is remembered (the box "Always use …" ticked, the default) in the
 * store's area `open`. Dismissing it resolves to undefined. Resolves to the id of the window the
 * handler opened, or undefined.
 */
export interface Open {
    (target: OpenTarget, options?: OpenOptions): Promise<string | undefined>;
    /** Registers `handler` while the calling plugin lives (an effect: unload removes it); the
     *  returned function removes it sooner. Throws if the id (`plugin/name`) is taken. */
    register(handler: OpenHandler): () => void;
    /** The registered handlers; with `target`, those that match it, best first, with their score
     *  and the remembered choice marked. */
    handlers(target?: OpenTarget): OpenHandlerRow[];
    /** The remembered choices: key (`file:.ts`) → handler id. */
    defaults(): Record<string, string>;
    /** Forgets the remembered choice for `key` (a key of `defaults()`, or a target's), or every
     *  one when unset. */
    forget(key?: string | OpenTarget): void;
}
/** `ctx.plugins`: the host. Every state change emits `plugins/change`. */
export interface PluginHost {
    /** One row per plugin in plugins.json, in its order. */
    list(): PluginRow[];
    /** Switches a plugin on or off (no-op for a locked one); the choice persists. */
    toggle(name: string): Promise<void>;
    /** Imports the plugin's file again and swaps the running instance. Resolves to a note for the
     *  log (`clock: reloaded`, `clock: import failed: …`, `clock: incompatible: needs …`); does not
     *  reject on a bad file. */
    reload(name: string): Promise<string>;
    /** Re-reads plugins.json and adds and removes plugins to match it. Resolves to a note. */
    sync(): Promise<string>;
}
/** `window.tilr`: the root context (for the Safari console) and the native app's entry. */
export interface TilrGlobal {
    root: Context;
    /** The version of the plugin API this page implements (package.json's `version`), what a
     *  plugin's `api` range is checked against. */
    api: string;
    /** The React build in site/vendor/: `dev`, `profiling` or `prod` (build.mjs `--react`). */
    react: 'dev' | 'profiling' | 'prod';
    hmr: {
        /** Called by the native app with paths relative to the site folder; resolves to a note
         *  for the app's stdout. */
        changed(paths: string[]): Promise<string>;
    };
    /** The running services by name, for agents and the console: `tilr.services.server.list()`.
     *  Reading one that is not running throws `no service "x" is running`; `Object.keys()` lists
     *  the running ones. Tilr Control's `eval` has it as `$`. */
    services: TilrServices & Record<string, unknown>;
    /** What runs and what it can do: every running service (`api` null), or one with its
     *  declarations. */
    describe(service?: string): Promise<ServiceDescription[]>;
}
declare module 'cordis' {
    interface Context extends TilrServices {
    }
    interface Events {
        'plugins/change'(): void;
        /** A window type was registered or removed. */
        'windows/change'(): void;
        /** A window opened, closed, moved, changed mode, focus, title or config. */
        'layout/change'(change?: LayoutChange): void;
        /** An element was marked or unmarked with `ctx.ui.overlay()`, or one changed its size
         *  (shown, hidden, resized). */
        'ui/overlay'(): void;
        /** A plugin asks for a window on behalf of its own (`ctx.layout.open(spec, { from })`). A
         *  request, dispatched with `ctx.bail`: the first handler to return an id wins. A container
         *  that wants the window (a tabs window listening to that opener) opens it inside itself
         *  (`layout.open({ ...spec, parent: me })`) and returns the id; when none does, the layout
         *  opens it as `open(spec)` would. The layout does not listen itself: its fallback would
         *  shadow the containers. */
        'window/open'(request: OpenRequest): string | undefined;
        /** A key of the store changed (`value` undefined: deleted), here, in another tab, or later
         *  on another device. */
        'store/change'(area: string, key: string, value: Json | undefined): void;
        /** The store switched backends (reserved: the store never emits it yet). */
        'store/backend'(backend: string): void;
        /** `ctx.sshagent`'s `available` or `path` changed. */
        'sshagent/change'(): void;
    }
}
declare global {
    interface Window {
        tilr: TilrGlobal;
    }
}
