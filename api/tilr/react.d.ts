import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { Context } from 'cordis';
import type { PluginMeta, TilrPluginObject, WindowField, WindowHandle, WindowType } from 'tilr';
/** What a window component receives. */
export interface WindowProps<C = unknown> {
    win: WindowHandle<C>;
}
/**
 * Renders `element` into `host` as a React root and returns the undo: the `mount` of a
 * WindowType written by hand (`ctx.windows.register('x', { mount: (host, win) => mount(host, <X win={win} />) })`).
 * The unmount is deferred a microtask: the layout calls it from an effect of its own React tree,
 * where unmounting another root synchronously is refused.
 */
export declare function mount(host: HTMLElement, element: ReactNode): () => void;
/** The current window. With fields, re-renders only when selected values change.
 * Without fields, keeps the legacy subscription to every layout change. */
export declare function useWindow<C = unknown>(fields?: readonly WindowField[]): WindowHandle<C>;
/** A selected window field with a cached snapshot. Configs must be replaced rather than
 * mutated. Older providers may broadcast, but equal snapshots still skip React updates. */
export declare function useWindowField<K extends WindowField>(field: K): WindowHandle[K];
/** The cordis context of the plugin that registered the window's type (`ctx.on`, services it injected). */
export declare function useCtx(): Context;
/** The element a window type's `mount` renders, so that `useWindow()` works below it. */
export declare function windowRoot(ctx: Context, win: WindowHandle, children: ReactNode): ReactElement;
/** `windowType()`'s argument: the WindowType minus `mount`, the component, the plugin's metadata. */
export interface WindowTypeOptions<C> extends Omit<WindowType<C>, 'mount'>, Pick<PluginMeta, 'author' | 'tags' | 'version' | 'api' | 'requires'> {
    /** The type's name, and the plugin's. */
    id: string;
    component: ComponentType<WindowProps<C>>;
}
/** A plugin that registers one window type drawn by a React component. */
export declare function windowType<C = undefined>(options: WindowTypeOptions<C>): TilrPluginObject;
