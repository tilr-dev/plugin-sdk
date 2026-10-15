// `tilr mcp`: an MCP server on stdio (newline-delimited JSON-RPC, no dependencies) that gives an
// agent the running Tilr app: see it (a snapshot, the console), drive the page (switch plugins,
// open and move windows, call any service), manage the app's plugins (add, update, remove), and
// export an app as a template or make one from it. Everything goes through Tilr Control
// (control.mjs) and the `tilr plugin` / `tilr app` commands.
//
//   claude mcp add tilr -- tilr mcp
import { readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { act, call, control, controlSocket, debug, debugMetrics, describe, describeText, evaluate, metricRows, metricsText, plugins, snapshot, windowId, windowsText } from './control.mjs'
import { addSitePlugins, pluginTarget } from './plugin-target.mjs'
import { browserTools } from './browser-tools.mjs'
import { runBench, SCENARIOS, writeBench } from './bench.mjs'
import { debugFootprint, debugInspect, debugSqueeze, footprintText, inspectText, memoryPath, memoryText, runMemory, squeezeText } from './memory.mjs'

const TILR = fileURLToPath(new URL('./tilr.mjs', import.meta.url))
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const socket = controlSocket()

const APP = { app: { type: 'string', description: 'The app (window) by name; the current one when omitted. tilr_apps lists them.' } }
const object = (properties, required = []) => ({ type: 'object', properties, required })
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const opts = ({ app }) => ({ socket, ...(app ? { app } : {}) })
/** A window as an agent names it: what `resolveWindow` (control.mjs) takes. */
const WINDOW = { type: 'string', description: 'A window: its id, title, type, or a part / glob (π*) of its title.' }

/** The folder of the app (tilr.json, plugins/, site/) that the shell shows as `app`. */
async function appTarget(app) {
  const { apps } = await control({ cmd: 'apps' }, { socket })
  const row = app ? apps.find(a => a.name === app) : apps.find(a => a.current)
  if (!row) throw new Error(app ? `no app "${app}"; the apps: ${apps.map(a => a.name).join(', ')}` : 'no app')
  return pluginTarget(row)
}

async function appDir(app) {
  const { dir, site } = await appTarget(app)
  if (!dir) throw new Error(`${site} is a standalone site; this operation requires a managed app with tilr.json. tilr_plugin add can install core or local plugins into this site directly`)
  return dir
}

/** `tilr …`, its output as the result. */
function tilr(args) {
  const r = spawnSync(process.execPath, [TILR, ...args], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (r.status !== 0) throw new Error(out || `tilr ${args.slice(0, 2).join(' ')} failed`)
  return out || 'done'
}

/** `tilr plugin <verb> …` on the app's folder. */
const plugin = (verb, args, dir) => tilr(['plugin', verb, ...args, '--app', dir])

const TOOLS = [
  ...browserTools(control, socket),
  {
    name: 'tilr_apps',
    description: 'The apps the Tilr shell shows (one window each), which is current, and their site folders.',
    inputSchema: object({}),
    run: () => control({ cmd: 'apps' }, { socket }),
  },
  {
    name: 'tilr_switch',
    description: 'Shows an app (switches the window to it).',
    inputSchema: object({ app: { type: 'string', description: 'The app by name.' } }, ['app']),
    run: ({ app }) => control({ cmd: 'switch', app }, { socket }),
  },
  {
    name: 'tilr_ui',
    description: 'The page as an agent sees it: every window\'s controls with refs (`button "Save" [e10] → server.update`), values and states; a window whose content is not DOM (a terminal) as `document "title" [e7]` with its text\'s last lines. Start here, then tilr_act, or tilr_api + tilr_call for the direct route.',
    inputSchema: object({ window: { ...WINDOW, description: `${WINDOW.description} All when omitted.` }, lines: { type: 'number', description: 'Lines of a document\'s text shown, the last ones (40).' }, ...APP }),
    run: async ({ window, lines, app }) => snapshot({ ...(window ? { window: await windowId(window, opts({ app })) } : {}), lines, ...opts({ app }) }),
  },
  {
    name: 'tilr_act',
    description: 'Does what a person would to an element of tilr_ui by its ref, through real DOM events, and returns its window\'s snapshot after. `fill` on a window\'s document sends text to a window that supports it (a terminal: the command, a trailing "\\n" runs it); `wait.until` (a regex, multiline) waits for the reply before the snapshot. A gone ref means: take a new tilr_ui.',
    inputSchema: object({
      ref: { type: 'string', description: 'e12, from tilr_ui; "" with press: the focused element.' },
      action: { type: 'string', enum: ['click', 'dblclick', 'fill', 'select', 'check', 'uncheck', 'focus', 'press', 'scroll'] },
      value: { type: 'string', description: 'fill: the text; select: an option\'s value or text; press: a key (Enter, Escape, a, Meta+k).' },
      wait: object({
        until: { type: 'string', description: 'A regex (multiline; line ends trimmed, a `$ ` prompt is \\$$) the window\'s text must match.' },
        idleMs: { type: 'number', description: 'Else: quiet this long (300).' },
        timeoutMs: { type: 'number', description: 'Give up (no error) after (10000).' },
      }),
      lines: { type: 'number', description: 'As for tilr_ui (40).' },
      ...APP,
    }, ['ref', 'action']),
    run: ({ ref, action, value, wait, lines, app }) => act(ref, action, value, { wait, lines, ...opts({ app }) }),
  },
  {
    name: 'tilr_api',
    description: 'What runs and what it can do: every service of the page with its provider, version, methods and fields; with `service`, also its declarations (api.d.ts). The contract is the service\'s interface there; members outside it are listed as internal: callable, but a last resort. Call them with tilr_call.',
    inputSchema: object({ service: { type: 'string' }, ...APP }),
    run: async ({ service, app }) => describeText(await describe(service, opts({ app })), service !== undefined),
  },
  {
    name: 'tilr_snapshot',
    description: 'A picture of the page as the window shows it right now. Use it to see what is on screen.',
    inputSchema: object(APP),
    async run({ app }) {
      const path = join(tmpdir(), `tilr-snapshot-${process.pid}-${Date.now()}.png`)
      const result = await control({ cmd: 'snapshot', path, ...(app ? { app } : {}) }, { socket })
      try {
        const data = readFileSync(path).toString('base64')
        return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: `${result.width}×${result.height}` }] }
      } finally { rmSync(path, { force: true }) }
    },
  },
  {
    name: 'tilr_console',
    description: "The page's console (console.log/info/warn/error and uncaught errors), oldest first, as kept by the shell.",
    inputSchema: object({ ...APP, clear: { type: 'boolean', description: 'Forget the messages after reading them.' } }),
    run: ({ app, clear }) => control({ cmd: 'console', clear: !!clear, ...(app ? { app } : {}) }, { socket }),
  },
  {
    name: 'tilr_reload',
    description: 'Reloads the page of an app.',
    inputSchema: object(APP),
    run: ({ app }) => control({ cmd: 'reload', ...(app ? { app } : {}) }, { socket }),
  },
  {
    name: 'tilr_eval',
    description: 'Runs JavaScript in the page: the body of an async function (use `return`; a bare expression is returned). `$` is the running services (`$.layout.list()`); `window.tilr.root` is the cordis root.',
    inputSchema: object({ js: { type: 'string' }, ...APP }, ['js']),
    run: ({ js, app }) => evaluate(js, opts({ app })),
  },
  {
    name: 'tilr_call',
    description: "Calls a method of a service of the page: plugins (list, toggle, reload, sync), layout (list, open, close, float, tile, focus, setTitle, setConfig), windows (list, get), ui (snapshot, act), open (no method: the service itself, args [target, options]: opens a file or URL in its handler; handlers, defaults, forget), or any service a plugin provides (tilr_api lists them). Or `expr` instead: `$.server.get('local').connect()`; `$` = running services.",
    inputSchema: object({
      service: { type: 'string' }, method: { type: 'string' }, args: { type: 'array', description: 'The arguments, as JSON.' },
      expr: { type: 'string', description: 'An expression instead of service/method: `$.server.get(\'local\').connect()`.' },
      ...APP,
    }),
    run({ service, method, args = [], expr, app }) {
      if (expr !== undefined) {
        if (service !== undefined || method !== undefined) throw new Error('tilr_call: expr, or service and method, not both')
        return evaluate(`return (${expr})`, opts({ app }))
      }
      if (!service) throw new Error('tilr_call: service and method (or expr)')
      return call(service, method, args, opts({ app }))
    },
  },
  {
    name: 'tilr_debug',
    description: "The page's Performance collector (the Performance web plugin; per tab, off by default); 'tilr' mark() / measure() / metric() feed it (plugin starts, window open/close, layout changes, page:ready, pipeline hops) besides what it samples itself. status: enabled, the recordings' dir, the React build (dev / profiling / prod), whether a recording runs. on / off: switch it (answers { requested, reloading }: the page reloads when it changes; give it a few seconds before other calls). record: the next `seconds` (default 5) of the page's timeline written as a JSON file, answered with its path and a summary, a line per finding; do what you want measured meanwhile, e.g. with tilr_act. metrics: the page's metric() series as a table: count, rate/s, p50 / p95 / max over the last 10 s, n (how many values; '(tail)': only the latest 256, not the whole 10 s), last; `filter` keeps names starting with it. bench: terminal performance scenarios (needs collection on) in a fresh floating terminal window, closed after: `scenario` throughput (seq 1 200000: wall time, frames, bytes, hop p50/p95, draw time, FPS, CPU), typing (60 keydowns 50 ms apart: key_to_frame / key_to_paint / echo / rtt), idle (`seconds`, 10: CPU, memory, React commits/s, frames, draw) or all; answers the result JSON, also written to `out` (default the debug dir, bench-<time>.json); a failure midway writes the scenarios done with `error` and fails. Compare two results with `tilr ctl debug compare A.json B.json`. memory: is memory growth a leak or normal (needs collection on): probes every `interval` s (5) for `seconds` (120) process memory, windows, DOM nodes, Cordis listeners per plugin, React roots, and (Mac app permitting) the footprint by category (malloc, graphics, js, jit, other); with `squeeze` (default true) WebKit is asked to release memory after the first probe and at the end, and what stays after each squeeze is compared; answers per process first / last / min / max, slope MiB/min, max drawdown, peak, after-squeeze first / last, retained, a verdict (plateau, gc-sawtooth, growing, growing-sawtooth, flat; with squeezes leak-suspect or cache-only) and hints (which plugin's listeners grew, a DOM leak, the JS heap, compositing layers, garbage), written to `out` (default the debug dir, memory-<time>.json). footprint: memory by category per process now (MiB table). squeeze: ask WebKit to release memory, WebContent before → after (may reach other apps: a low-memory signal). inspect: open Safari Web Inspector for the page (Layers shows compositing layers). The last three need the updated Mac app (n/a otherwise).",
    inputSchema: object({
      action: { type: 'string', enum: ['status', 'on', 'off', 'record', 'metrics', 'bench', 'memory', 'footprint', 'squeeze', 'inspect'] },
      squeeze: { type: 'boolean', description: 'memory: squeeze WebKit after the first probe and at the end (true when omitted).' },
      filter: { type: 'string', description: 'metrics: a name prefix, e.g. "terminal."' },
      seconds: { type: 'number', description: 'record: how long, 5 when omitted. bench: the idle scenario\'s length, 10 when omitted. memory: how long, 120 when omitted.' },
      interval: { type: 'number', description: 'memory: seconds between probes, 5 when omitted.' },
      path: { type: 'string', description: 'record: where to write the JSON (~ allowed); the app picks a file in its dir when omitted.' },
      scenario: { type: 'string', enum: ['all', ...SCENARIOS], description: 'bench: which, all when omitted.' },
      out: { type: 'string', description: 'bench, memory: where to write the result JSON (~ allowed); the debug dir when omitted.' },
    }, ['action']),
    run: async ({ action, seconds, interval, path, filter, scenario = 'all', out, squeeze }) => {
      const where = out ? resolve(out.replace(/^~(?=$|\/)/, homedir())) : undefined
      if (action === 'bench') {
        const { result, dir } = await runBench({ scenarios: scenario === 'all' ? SCENARIOS : [scenario], ...(seconds !== undefined ? { seconds } : {}), socket })
        const written = await writeBench(result, { out: where, dir })
        if (result.error) throw new Error(`bench failed: ${result.error}; the partial result (${Object.keys(result.scenarios).join(', ') || 'no scenario'}) is in ${written}`)
        return { path: written, ...result }
      }
      if (action === 'memory') {
        const { result, dir } = await runMemory({ ...(seconds !== undefined ? { seconds } : {}), ...(interval !== undefined ? { interval } : {}), ...(squeeze !== undefined ? { squeeze } : {}), socket })
        const written = await writeBench(result, { out: where ?? memoryPath(dir) })
        if (result.error) throw new Error(`memory failed: ${result.error}; the partial result is in ${written}\n${memoryText(result)}`)
        return `${memoryText(result)}\n${written}`
      }
      if (action === 'footprint') return footprintText(await debugFootprint({ socket }))
      if (action === 'squeeze') return squeezeText(await debugSqueeze({ socket }))
      if (action === 'inspect') return inspectText(await debugInspect({ socket }))
      if (action !== 'metrics') return debug(action, { seconds, path }, { socket })
      const data = await debugMetrics({ socket })
      if (!data) throw new Error('Performance collection is off (tilr_debug on)')
      return metricsText(metricRows(data, { filter }))
    },
  },
  {
    name: 'tilr_plugins',
    description: 'The plugins of the page (plugins.json): name, state (active / off / failed / incompatible / pending), error, what each provides and injects, version.',
    inputSchema: object(APP),
    run: ({ app }) => plugins(opts({ app })),
  },
  {
    name: 'tilr_plugin',
    description: "One plugin operation. In the page: toggle (on / off, persists), reload (import its file again). On the app's folder: add (`sources`: core names, Git URLs or local paths, cloned and built; a standalone site, the Mac default too, takes core names and local plugin directories, built with npm run build; include required service plugins, e.g. webviews for browser), remove (from the folder and site; the clone stays), update (fetch upstream, merge, rebuild, reinstall; `names` or all), build (rebuild and reinstall; `names` or all), status (clean / modified / forked +N / behind -M with `fetch`, and where each comes from).",
    inputSchema: object({
      op: { type: 'string', enum: ['add', 'remove', 'update', 'build', 'status', 'toggle', 'reload'] },
      name: { type: 'string', description: 'toggle, reload, remove: the plugin.' },
      names: { type: 'array', items: { type: 'string' }, description: 'update, build: these (all when omitted).' },
      sources: { type: 'array', items: { type: 'string' }, description: 'add: what to install.' },
      ref: { type: 'string', description: 'add: a branch, tag or commit of a git source.' },
      fetch: { type: 'boolean', description: 'status: fetch upstream first.' },
      ...APP,
    }, ['op']),
    async run({ op, name, names = [], sources, ref, fetch, app }) {
      const named = () => { if (!name) throw new Error(`tilr_plugin ${op}: which plugin (name)?`); return name }
      switch (op) {
        case 'toggle': { const which = named(); await call('plugins', 'toggle', [which], opts({ app })); return (await plugins(opts({ app }))).find(r => r.name === which) }
        case 'reload': return call('plugins', 'reload', [named()], opts({ app }))
        case 'add': {
          const list = sources ?? (name ? [name] : [])
          if (!list.length) throw new Error('tilr_plugin add: sources')
          const { dir, site } = await appTarget(app)
          if (dir) return plugin('add', [...list, ...(ref ? ['--ref', ref] : [])], dir)
          return addSitePlugins({ site, sources: list, ref, kit: dirname(dirname(TILR)) })
        }
        case 'remove': return plugin('remove', [named()], await appDir(app))
        case 'update': return plugin('update', names, await appDir(app))
        case 'build': return plugin('build', names, await appDir(app))
        case 'status': return plugin('status', fetch ? ['--fetch'] : [], await appDir(app))
        default: throw new Error(`tilr_plugin: op is add, remove, update, build, status, toggle or reload, not ${JSON.stringify(op)}`)
      }
    },
  },
  {
    name: 'tilr_windows',
    description: 'The open windows, a line each: `id  type  tile|float|nested  "title"` (+ [focused]); tabs not shown by their container are left out unless `all`. `verbose`: the layout\'s rows as JSON (rect, config, mounted, parent, children). tilr_call windows.list gives the registered types.',
    inputSchema: object({ all: { type: 'boolean' }, verbose: { type: 'boolean' }, ...APP }),
    run: async ({ all, verbose, app }) => {
      const rows = await call('layout', 'list', [], opts({ app }))
      return verbose ? rows : windowsText(rows, { all: !!all })
    },
  },
  {
    name: 'tilr_window',
    description: 'One window operation. open: a window of a registered `type` (tilr_call windows.list), with `config`, `mode`, `title`; returns its id. close, focus (a float comes to the top), float (out of the tiling, at `rect`; missing fields keep their value), tile (back into the tiling): the `window`.',
    inputSchema: object({
      op: { type: 'string', enum: ['open', 'close', 'float', 'tile', 'focus'] },
      window: WINDOW,
      type: { type: 'string', description: 'open: the window type.' },
      config: { description: 'open: JSON saved with the window; the type\'s default when omitted.' },
      mode: { type: 'string', enum: ['tile', 'float'], description: 'open.' },
      title: { type: 'string', description: 'open.' },
      rect: object({ x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }),
      ...APP,
    }, ['op']),
    async run({ op, window, id, type, config, mode, title, rect, app }) {
      const o = opts({ app })
      if (op === 'open') {
        if (!type) throw new Error('tilr_window open: which type?')
        return call('layout', 'open', [{ type, ...(config !== undefined ? { config } : {}), ...(mode ? { mode } : {}), ...(title ? { title } : {}) }], o)
      }
      if (!['close', 'float', 'tile', 'focus'].includes(op)) throw new Error(`tilr_window: op is open, close, float, tile or focus, not ${JSON.stringify(op)}`)
      const target = await windowId(window ?? id, o)
      await call('layout', op, op === 'float' && rect ? [target, rect] : [target], o)
      return `${op}: ${target}`
    },
  },
  {
    name: 'tilr_app_export',
    description: "Writes an app as a template folder (tilr app export): tilr.json, a copy of each cloned plugin with its .git and local edits (no node_modules, no build output), and the running window's whole store as store.json (secure areas too). Nothing in it needs the network to make the app again with tilr_app_new.",
    inputSchema: object({
      dir: { type: 'string', description: 'Where to write the template, an absolute path: a folder that does not exist or is empty.' },
      window: { type: 'string', description: 'The window whose store to export; the app\'s own when omitted.' },
      no_store: { type: 'boolean', description: 'Leave the store out (no store.json).' },
      ...APP,
    }, ['dir']),
    async run({ dir, window, no_store, app }) {
      const folder = await appDir(app)
      const name = window ?? app ?? (await control({ cmd: 'apps' }, { socket })).apps.find(a => a.current)?.name
      return tilr(['app', 'export', dir, '--app', folder, ...(no_store ? ['--no-store'] : name ? ['--window', name] : []), ...(socket ? ['--socket', socket] : [])])
    },
  },
  {
    name: 'tilr_app_new',
    description: "Makes a new app folder (tilr app new): tilr.json, a git repo, the core page in site/. With `from`, a template's (tilr_app_export): its plugins in order, the cloned ones copied from the template and built here, its store.json as the seed the page loads on its first start, and the lines to add under `apps:` in the Mac app's config in the answer.",
    inputSchema: object({
      dir: { type: 'string', description: 'The new app\'s folder, an absolute path: absent or empty.' },
      from: { type: 'string', description: 'A template folder.' },
      name: { type: 'string', description: 'The app\'s name; the template\'s, else the folder\'s name, when omitted.' },
    }, ['dir']),
    run: ({ dir, from, name }) => tilr(['app', 'new', dir, ...(from ? ['--from', from] : []), ...(name ? ['--name', name] : [])]),
  },
]

// ---- the server: JSON-RPC 2.0 over stdio, one message per line -------------------------------

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

async function handle(message) {
  const { id, method, params = {} } = message
  const reply = result => { if (id !== undefined) send({ id, result }) }
  const fail = (code, text) => { if (id !== undefined) send({ id, error: { code, message: text } }) }
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tilr', version } })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name)
      if (!tool) return fail(-32602, `unknown tool ${params.name}`)
      try {
        const result = await tool.run(params.arguments ?? {})
        return reply(result && typeof result === 'object' && Array.isArray(result.content) ? result : text(result ?? 'done'))
      } catch (error) {
        return reply({ content: [{ type: 'text', text: error.message }], isError: true })
      }
    }
    default:
      return fail(-32601, `unknown method ${method}`)
  }
}

let buffer = ''
const pending = new Set()
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { send({ id: null, error: { code: -32700, message: 'parse error' } }); continue }
    const job = handle(message).catch(error => send({ id: message.id ?? null, error: { code: -32603, message: error.message } }))
    pending.add(job)
    job.finally(() => pending.delete(job))
  }
})
// The client hung up: answer what is in flight, then leave.
process.stdin.on('end', () => { Promise.allSettled([...pending]).then(() => process.exit(0)) })
