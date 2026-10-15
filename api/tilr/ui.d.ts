import type { ReactElement, ReactNode } from 'react';
export { element, frame, frameControls, FRAME } from '../dom.js';
export type { FrameControl, FrameOptions, FrameParts, FrameWindow } from '../dom.js';
/**
 * The standard frame: a `.tile` with a title bar (the drag handle), the float / tile and close
 * buttons, and the body. The same markup `frame()` builds for a plugin that does not use React,
 * and `ctx.ui.tile()` gives. `title` defaults to the window's.
 */
export declare function Frame({ title, controls, children }: {
    title?: string;
    controls?: boolean;
    children?: ReactNode;
}): ReactElement;
