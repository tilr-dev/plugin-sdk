// The client of Tilr Control, the running shell's socket (apps/mac/Sources/Tilr/Control.swift):
// one JSON object per line each way. `tilr ctl` and `tilr mcp` are built on this.
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { configDir } from './paths.js'

/** The socket path: `--socket` (taken out of `argv`), $TILR_CONTROL, `control: socket:` in
 *  the selected config folder's config.yml, else the default. */
export function controlSocket(argv = []) {
  const i = argv.indexOf('--socket')
  if (i !== -1) {
    const [, value] = argv.splice(i, 2)
    if (!value) throw new Error('--socket needs a path')
    return expand(value)
  }
  if (process.env.TILR_CONTROL) return expand(process.env.TILR_CONTROL)
  try {
    const config = readFileSync(join(configDir(), 'config.yml'), 'utf8')
    const block = /^control:[ \t]*\n((?:[ \t]+.*\n?)*)/m.exec(config)?.[1] ?? ''
    const socket = /^[ \t]+socket:[ \t]*(.+?)[ \t]*$/m.exec(block)?.[1]
    if (socket !== undefined) {
      const value = expand(socket.replace(/^(['"])(.*)\1$/, '$2'))
      return value ? resolve(configDir(), value) : ''
    }
  } catch {}
  return join(configDir(), 'control.sock')
}

const expand = path => path.replace(/^~(?=$|\/)/, homedir())

/** Sends one request and resolves to the reply's result (the object minus `id` and `ok`); rejects
 *  with the reply's error, or with what went wrong on the way. */
export function control(request, { socket = controlSocket(), timeout = 30_000 } = {}) {
  if (!socket)
    return Promise.reject(
      new Error('Tilr Control is off (control.socket in the selected config folder’s config.yml is empty)'),
    )
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket)
    let buffer = ''
    const timer = setTimeout(() => {
      connection.destroy()
      reject(new Error(`Tilr Control: no reply in ${timeout}ms`))
    }, timeout)
    connection.setEncoding('utf8')
    connection.on('connect', () => connection.write(JSON.stringify({ id: 1, ...request }) + '\n'))
    connection.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      connection.end()
      let reply
      try {
        reply = JSON.parse(buffer.slice(0, newline))
      } catch (error) {
        return reject(new Error(`Tilr Control: bad reply: ${error.message}`))
      }
      const { ok, error } = reply
      delete reply.id
      delete reply.ok
      delete reply.error
      ok ? resolve(reply) : reject(new Error(error ?? 'Tilr Control: failed'))
    })
    connection.on('error', error => {
      clearTimeout(timer)
      reject(
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new Error(
              `Tilr is not running, or its control socket is not ${socket} (control.socket in the selected config folder's config.yml)`,
            )
          : error,
      )
    })
  })
}

/** `service.method(...args)` in the page of `app` (the current one by default). No `method`:
 *  the service itself is called (a callable one, `open(target)`), through `eval`. */
export async function call(service, method, args = [], options = {}) {
  if (!method) return evaluate(`return $[${JSON.stringify(service)}](...${JSON.stringify(args)})`, options)
  const { app, ...rest } = options
  const { value } = await control({ cmd: 'call', service, method, args, ...(app ? { app } : {}) }, rest)
  return value
}

/** `js` as a function body: as written when it has a `return`, else returned as an expression
 *  (what the shell does; done here because the prelude below comes first). */
export function body(js) {
  return /\breturn\b/.test(js) ? js : `return (${js})`
}

/** The body of an async function, run in the page. `$` is the running services
 *  (`window.tilr.services`): `$.layout.list()`, `$.server.get('local').connect()`. The body is a
 *  block of its own, so a `$` it declares shadows this one. */
export async function evaluate(js, options = {}) {
  const { app, ...rest } = options
  const source = `const $ = window.tilr?.services;\n{\n${body(js)}\n}`
  const { value } = await control({ cmd: 'eval', js: source, ...(app ? { app } : {}) }, rest)
  return value
}

/** `ctx.ui.snapshot()`: the windows and their controls with refs, as text (or JSON); `lines`:
 *  of a document's text (40 by default). */
export function snapshot({ window, json = false, lines, ...options } = {}) {
  return call(
    'ui',
    'snapshot',
    [{ ...(window ? { window } : {}), ...(lines !== undefined ? { lines } : {}), format: json ? 'json' : 'text' }],
    options,
  )
}

/** `ctx.ui.act(ref, action, value, { wait, lines })`: resolves to the snapshot of the ref's
 *  window, as text. A wait gets its time on the socket too. */
export function act(ref, action, value, { wait, lines, ...options } = {}) {
  const extra = { ...(wait ? { wait } : {}), ...(lines !== undefined ? { lines } : {}) }
  const args = [ref, action, value === undefined ? null : String(value), ...(Object.keys(extra).length ? [extra] : [])]
  while (args.length > 2 && args.at(-1) === null) args.pop()
  const timeout = wait ? (wait.timeoutMs ?? 10_000) + 30_000 : undefined
  return call('ui', 'act', args, { ...options, ...(timeout ? { timeout } : {}) })
}

/** `window.tilr.describe(service)`: what runs and what it can do. */
export function describe(service, options = {}) {
  return evaluate(`return window.tilr.describe(${service === undefined ? '' : JSON.stringify(service)})`, options)
}

const signature = m => `${m.name}(${m.arity || ''})`

const INTERNAL = '(not in the contract, may change; callable all the same)'

/** `describe()` rows as text: a line per service (`name  plugin@version  methods  .fields`,
 *  the contract's members only, `+2 internal` for the rest), or, for one service, its members
 *  (the internal ones on their own lines) and its api.d.ts. */
export function describeText(rows, one = false) {
  const contract = list => list.filter(m => !m.internal)
  const internal = list => list.filter(m => m.internal)
  if (!one) {
    const width = Math.max(...rows.map(r => r.name.length))
    const from = r => `${r.plugin ?? '?'}${r.version ? `@${r.version}` : ''}`
    const fromWidth = Math.max(...rows.map(r => from(r).length))
    return rows
      .map(r => {
        const hidden = internal(r.methods).length + internal(r.fields).length
        const shown = [
          ...(r.callable ? ['(…)'] : []),
          ...contract(r.methods).map(signature),
          ...contract(r.fields).map(f => `.${f.name}`),
          ...(hidden ? [`+${hidden} internal`] : []),
        ]
        return `${r.name.padEnd(width)}  ${from(r).padEnd(fromWidth)}  ${shown.join(' ')}`.trimEnd()
      })
      .join('\n')
  }
  return rows
    .map(r =>
      [
        `${r.name}  ${r.plugin ?? '?'}${r.version ? `@${r.version}` : ''}`,
        ...(r.callable ? [`callable: ${r.name}(…), the service itself is a function`] : []),
        `methods: ${contract(r.methods).map(signature).join(' ') || '—'}`,
        ...(internal(r.methods).length
          ? [`internal: ${internal(r.methods).map(signature).join(' ')}  ${INTERNAL}`]
          : []),
        `fields: ${
          contract(r.fields)
            .map(f => f.name)
            .join(' ') || '—'
        }`,
        ...(internal(r.fields).length
          ? [
              `internal: ${internal(r.fields)
                .map(f => f.name)
                .join(' ')}  ${INTERNAL}`,
            ]
          : []),
        '',
        r.api ?? `(no api.d.ts: plugins/${r.plugin}/api.d.ts is not in the site)`,
      ].join('\n'),
    )
    .join('\n\n')
}

/** `ctx.plugins.list()` with each row's Error reduced to its message (an Error is `{}` as JSON). */
export function plugins(options) {
  return evaluate(
    `return window.tilr.root.get('plugins').list().map(r => ({ ...r, error: r.error ? r.error.message : null }))`,
    options,
  )
}

/** The shell's `debug` command (Control.swift), over the Performance web plugin's collector:
 *  `status` (enabled, react, mechanism, active: a page recording, dir, recording: a CLI record;
 *  mechanism 'none' and a reason without the plugin), `on` / `off` (the plugin's switch, the page
 *  reloads when it changes; answers `{ mechanism, requested, reloading }`), `record` (`seconds`,
 *  5 by default: the next seconds' recording written to `path`, the app's choice when omitted;
 *  answers `{ path, summary }`). */
export function debug(action, { seconds, path } = {}, { socket, app } = {}) {
  const request = { cmd: 'debug', action, ...(app ? { app } : {}) }
  if (action === 'record') {
    request.seconds = seconds ?? 5
    if (path) request.path = path
  }
  // A recording takes its seconds before the reply.
  const timeout = action === 'record' ? request.seconds * 1000 + 30_000 : undefined
  return control(request, { ...(socket !== undefined ? { socket } : {}), ...(timeout ? { timeout } : {}) })
}

/**
 * A `debug` action the Mac app may answer natively (`footprint`, `squeeze`, `inspect`): asked
 * natively first; an app without it (its "expected status, on, off or record") gets `page`, an
 * eval body run in the page instead (the Performance service over the page's bridge).
 */
export async function debugNative(action, page, { socket, app, timeout } = {}) {
  const options = { ...(socket !== undefined ? { socket } : {}), ...(timeout ? { timeout } : {}) }
  try {
    return await control({ cmd: 'debug', action, ...(app ? { app } : {}) }, options)
  } catch (error) {
    if (!/expected status|unknown (debug )?action/i.test(error.message)) throw error
  }
  return evaluate(page, { ...options, ...(app ? { app } : {}) })
}

/** A debug reply as text: `on` / `off`'s as a sentence, a status as `key: value` lines. */
export function debugText(status) {
  if (typeof status?.requested === 'boolean') {
    const state = status.requested ? 'on' : 'off'
    return `collection ${state}: ${status.reloading ? 'switching, the page reloads' : `already ${state}, no reload`} (${status.mechanism ?? 'performance'})`
  }
  return Object.entries(status)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n')
}

/** The page's metric series (`metric()` from 'tilr'), from the Performance plugin's `series()`
 *  (an older plugin's snapshot()), through `eval` (no native command): `{ ended, metrics }`, or
 *  null while collection is off. */
export function debugMetrics(options = {}) {
  return evaluate(
    `if (!("performance" in $)) throw new Error('Install and enable the Performance web plugin first.')
const p = $.performance
const ended = performance.now()
if (typeof p.series === 'function') { const metrics = p.series(); return metrics && { ended, metrics } }
const d = p.snapshot()
return d && { ended: d.ended, metrics: d.metrics ?? [] }`,
    options,
  )
}

/** The q-quantile (0..1) of `values` by the nearest-rank method; null for none. */
export const quantile = (values, q) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]
}

/** A series keeps its latest METRIC_RING observations (src/performance.ts). */
const METRIC_RING = 256
/** Labels in key order, as text: the order of an object's keys does not survive Tilr Control
 *  (Control.swift's JSONSerialization). */
const labelText = (labels, sep = ',') =>
  Object.keys(labels)
    .sort()
    .map(k => `${k}=${labels[k]}`)
    .join(sep)

/** A snapshot's metric series as rows: count, rate/s (over the whole seconds of the `window` ms
 *  before `ended`), p50 / p95 / max of the observations in the window, `n` of them and their
 *  `coverage` ('tail': the series' ring of the latest 256 did not reach back over the whole
 *  window), `last` (the window's Metrics table); only names starting with `filter`. */
export function metricRows({ ended, metrics }, { filter = '', window = 10_000 } = {}) {
  const from = ended - window
  const first = Math.ceil(from / 1000),
    last = Math.floor(ended / 1000) - 1
  const seconds = last - first + 1
  return metrics
    .filter(m => m.name.startsWith(filter))
    .map(m => {
      const values = m.recent.filter(([t]) => t > from && t <= ended).map(([, v]) => v)
      const count = m.seconds.filter(([s]) => s >= first && s <= last).reduce((n, [, c]) => n + c, 0)
      const coverage =
        m.count > METRIC_RING && m.recent.length >= METRIC_RING && m.recent[0][0] > from ? 'tail' : 'full'
      return {
        name: m.name,
        labels: m.labels,
        count: m.count,
        rate: seconds > 0 ? count / seconds : 0,
        p50: quantile(values, 0.5),
        p95: quantile(values, 0.95),
        max: values.length ? Math.max(...values) : null,
        n: values.length,
        coverage,
        last: m.last,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || labelText(a.labels).localeCompare(labelText(b.labels)))
}

/** metricRows() as an aligned text table. */
export function metricsText(rows) {
  if (!rows.length) return 'no metrics'
  const fmt = n => (n === null ? '-' : Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2))
  const table = [
    ['name', 'labels', 'count', 'rate/s', 'p50', 'p95', 'max', 'n', 'last'],
    ...rows.map(r => [
      r.name,
      labelText(r.labels) || '-',
      String(r.count),
      r.rate.toFixed(1),
      fmt(r.p50),
      fmt(r.p95),
      fmt(r.max),
      `${r.n ?? '-'}${r.coverage === 'tail' ? ' (tail)' : ''}`,
      fmt(r.last),
    ]),
  ]
  const widths = table[0].map((_, i) => Math.max(...table.map(row => row[i].length)))
  return table
    .map(row =>
      row
        .map((cell, i) => (i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

// ---- windows: finding one by what an agent knows of it, listing them compactly ---------------

/** A layout row as a line: `<id>  <type>  <mode>  "<title>"`, ` [focused]` when it is. */
const windowLine = row =>
  `${row.id}  ${row.type}  ${row.mode}  ${JSON.stringify(row.title)}${row.focused ? ' [focused]' : ''}`

/** Whether a row is drawn: not a nested window its container does not show (a tab behind
 *  another: placed nowhere, or measured 0×0), nor one inside such a window. */
export function shown(row, rows) {
  const byId = new Map(rows.map(r => [r.id, r]))
  for (
    let r = row, seen = new Set();
    r && !seen.has(r.id);
    seen.add(r.id), r = r.parent ? byId.get(r.parent) : undefined
  ) {
    if (r.mode === 'nested' && !(r.rect?.width > 0 && r.rect?.height > 0)) return false
  }
  return true
}

/** `ctx.layout.list()` rows as text, a line per window; the tabs nobody sees left out unless
 *  `all` (a last line says how many). */
export function windowsText(rows, { all = false } = {}) {
  const list = all ? rows : rows.filter(row => shown(row, rows))
  const lines = list.map(windowLine)
  const hidden = rows.length - list.length
  if (hidden) lines.push(`(+${hidden} hidden tab${hidden === 1 ? '' : 's'}: all: true lists them)`)
  return lines.join('\n') || 'no windows'
}

/**
 * The window `query` names, among the layout's `rows`: its id, its exact title, its type's
 * name, else a case-insensitive part of its title (`zsh`) or a glob of it (`π*`, `*log?`).
 * One match is the window; several or none throw, listing what there is.
 */
export function resolveWindow(query, rows) {
  if (typeof query !== 'string' || !query) throw new Error('which window? an id, a title, a type, or a part of a title')
  const byId = rows.find(row => row.id === query)
  if (byId) return byId
  const glob = /[*?]/.test(query)
    ? new RegExp(
        `^${query
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.')}$`,
        'i',
      )
    : null
  const lower = query.toLowerCase()
  const tiers = [
    rows.filter(row => row.title === query),
    rows.filter(row => row.type === query),
    rows.filter(row => (glob ? glob.test(row.title) : row.title.toLowerCase().includes(lower))),
  ]
  for (const found of tiers) {
    if (found.length === 1) return found[0]
    if (found.length > 1) {
      throw new Error(
        `"${query}" matches ${found.length} windows; name one by id:\n${found.map(row => `${row.id} ${JSON.stringify(row.title)} (${row.type})`).join('\n')}`,
      )
    }
  }
  throw new Error(
    `no window "${query}"; the open ones:\n${rows.length ? rows.map(row => `${row.id} ${JSON.stringify(row.title)} (${row.type})`).join('\n') : '(none)'}`,
  )
}

/** The id of the window `query` names in the running page (`resolveWindow`). */
export async function windowId(query, options = {}) {
  return resolveWindow(query, await call('layout', 'list', [], options)).id
}
