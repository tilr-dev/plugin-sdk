// Native WKWebViews have their own DOM and input path, separate from the Tilr host page.
const APP = { app: { type: 'string', description: 'App name; the current app if omitted.' } }
const object = (properties, required = []) => ({ type: 'object', properties, required })
const BROWSER = {
  browser: { type: 'string', description: 'Native browser id from tilr_browser_list.' },
  frame: { type: 'string', description: 'Frame id from tilr_browser_frames; main document if omitted.' },
  ...APP,
}
const TARGET = {
  ref: { type: 'string', description: 'Element ref from a fresh browser snapshot.' },
  selector: { type: 'string', description: 'CSS selector matching exactly one element in the selected frame.' },
  x: { type: 'number', description: 'Main browser viewport CSS x; use with y and without frame.' },
  y: { type: 'number', description: 'Main browser viewport CSS y.' },
}


export function browserTools(control, socket) {
  const browserCommand = (action, args) => control({ ...args, cmd: 'browser', action }, { socket })
  return [
  {
    name: 'tilr_browser_list',
    description: 'List native embedded browser views, their ids, URLs, titles, loading and visibility. Requires a Mac shell with browser automation support.',
    inputSchema: object(APP),
    run: args => browserCommand('list', args),
  },
  {
    name: 'tilr_browser_frames',
    description: 'List current native frames, including cross-origin iframes. Frame ids expire on navigation.',
    inputSchema: object({ browser: BROWSER.browser, ...APP }, ['browser']),
    run: args => browserCommand('frames', args),
  },
  {
    name: 'tilr_browser_snapshot',
    description: 'Read an embedded browser document: visible text and controls with element refs. Choose frame to inspect an iframe. Refs expire with their document or element.',
    inputSchema: object(BROWSER, ['browser']),
    run: args => browserCommand('snapshot', args),
  },
  {
    name: 'tilr_browser_evaluate',
    description: 'Execute an async JavaScript function body in the embedded website or selected iframe. Use return for results; args is the supplied JSON value. Supports await fetch/AJAX, subject to the website origin/CORS. Times out using browser.automation_timeout; timing out does not undo side effects or cancel outstanding fetches.',
    inputSchema: object({ ...BROWSER, js: { type: 'string' }, args: { description: 'JSON input exposed as args.' } }, ['browser', 'js']),
    run: args => browserCommand('evaluate', args),
  },
  {
    name: 'tilr_browser_navigate',
    description: 'Navigate an embedded browser; returns when navigation is dispatched. Inspect loading with tilr_browser_list and refresh frame ids afterward.',
    inputSchema: object({ browser: BROWSER.browser, url: { type: 'string' }, ...APP }, ['browser', 'url']),
    run: args => browserCommand('navigate', args),
  },
  {
    name: 'tilr_browser_act',
    description: 'Dispatch native AppKit click/hover, or DOM scrollBy in the embedded browser. Scroll returns before/after offsets; it does not emit a wheel event. Target an element by ref/selector in a frame, or x/y in the main viewport; no target uses the viewport center for click/hover and the document for scroll. Covered/hidden click and hover targets fail. Positive deltaY scrolls down; deltaX scrolls right, in pixels. Click/hover acknowledgement does not wait for page effects.',
    inputSchema: object({ ...BROWSER, ...TARGET,
      action: { type: 'string', enum: ['click', 'hover', 'scroll'] },
      deltaX: { type: 'number' }, deltaY: { type: 'number' },
    }, ['browser', 'action']),
    run: ({ action, ...args }) => browserCommand(action, args),
  },

  ]
}
