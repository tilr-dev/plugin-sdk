import type { WindowHandle } from './types.ts';
/** The parts of the standard frame: `<section class="tile"><header data-window-drag>` (the title
 *  bar, the drag handle), `<div class="controls">` (its buttons), `<div class="body">`. */
export declare const FRAME: {
    readonly tile: "tile";
    readonly controls: "controls";
    readonly body: "body";
    /** The attribute of the drag handle: the layout drags a window by the element that has it. */
    readonly drag: "data-window-drag";
};
/** What the frame's buttons need of a window. */
export type FrameWindow = Pick<WindowHandle, 'mode' | 'modes' | 'close' | 'requestFloat' | 'requestTile'>;
/** One button of the standard frame. */
export interface FrameControl {
    /** Its marker attribute, `data-float` or `data-close`: what a test or a stylesheet finds it by. */
    readonly id: 'float' | 'close';
    /** Its aria-label: every control is named, for an agent reading a snapshot. */
    readonly label: string;
    readonly text: string;
    /** Its `data-call`: the layout's method it stands for (`layout.float`, `layout.tile`,
     *  `layout.close`), for an agent reading a snapshot. */
    readonly call: string;
    /** What a click does, read off the window at the time of the click. */
    run(): void;
}
/**
 * The buttons of the standard frame for the window as it is now: float / tile (only for a type
 * with two modes or more) and close. Draw them again when `mode` or `modes` change; `frame()`
 * and `<Frame>` do.
 */
export declare function frameControls(win: FrameWindow): FrameControl[];
/**
 * Draws `frameControls(win)` as buttons into `host` (after what it holds already: a plugin's own
 * controls go first) and keeps them current: `data-call` follows the mode, the float button
 * comes and goes with `modes`. Returns the undo, which removes the buttons. The buttons keep
 * their identity across updates (focus survives a float).
 */
export declare function drawControls(host: HTMLElement, win: FrameWindow & Pick<WindowHandle, 'subscribe'>): () => void;
/** `frame()`'s options. */
export interface FrameOptions {
    /** More classes on the `<section class="tile">`: `'browser-tile'`. */
    className?: string;
    /** The title bar's text. Omitted: the window's title, kept current. `null`: left alone (the
     *  plugin writes the header itself). */
    title?: string | null;
    /** The float / tile and close buttons (default true). Without them `controls` is empty. */
    controls?: boolean;
}
/** What `frame()` returns: the parts, and the undo. */
export interface FrameParts {
    /** The `<section class="tile">`: append it to the window's host. */
    tile: HTMLElement;
    /** The title bar, the drag handle. */
    header: HTMLElement;
    /** The buttons' row; a plugin's own controls may be prepended. */
    controls: HTMLElement;
    /** Where the window's content goes. */
    body: HTMLElement;
    /** Stops following the window and removes the tile. */
    dispose(): void;
}
/**
 * The standard frame for a window drawn with the DOM, what `<Frame>` is for React: the title bar
 * (the drag handle), the float / tile and close buttons (with aria-labels and `data-call`, the
 * float one only for a type with two modes or more) and the body.
 *
 *   mount(host, win) {
 *     const { tile, body, dispose } = frame(win, { className: 'clock-tile' })
 *     body.append(element('div', 'big', 'hello'))
 *     host.append(tile)
 *     return dispose
 *   }
 */
export declare function frame(win: FrameWindow & Pick<WindowHandle, 'title' | 'subscribe'>, options?: FrameOptions): FrameParts;
/** `document.createElement(tag)` with a class and a text: `element('div', 'row', name)`. */
export declare function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K];
