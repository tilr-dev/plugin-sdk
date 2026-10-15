// `tilr ctl debug bench` and `tilr ctl debug compare`: terminal performance scenarios, run
// through Tilr Control (`eval` in the page, the Performance service's record() / finish()), so a
// change can be measured before and after. The numbers come from the recording a scenario made:
// its `metrics` (the series of the bench terminal's pane) and its `samples` (process CPU and
// memory, FPS, React commits). The extraction and the comparison are pure functions over JSON
// (tools/bench.test.mjs); runBench() is the driver.
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { debug, evaluate, quantile } from './control.mjs'

export const SCENARIOS = ['throughput', 'typing', 'idle']
/** The `terminal` chain's hops (plugin-server's 20-wait … 70-decode, the terminal's 80-apply …
 *  95-paint) and their metrics. */
export const HOPS = {
  wait: 'server.wait',
  parse: 'server.parse',
  build: 'server.build',
  encode: 'server.encode',
  transport: 'server.transport',
  decode: 'server.decode',
  apply: 'terminal.apply',
  draw: 'terminal.draw',
  paint: 'terminal.paint',
}
/** A recording auto-stops at 60 s (the Performance service): a scenario stays under it. */
export const MAX_SECONDS = 55
export const MARKER = '__TILR_BENCH_DONE__'
const TYPING_KEYS = 60
const TYPING_INTERVAL = 50

// ---- extraction: pure, over a recording (version 1) --------------------------------------------

/** ms (and %) with one decimal; null stays null. */
export const ms = n => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10)
/** Bytes and counts: integers. */
const int = n => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n))

/** The q-quantile of `values` (nearest rank): control.mjs' quantile, under the name the tests use. */
export const percentile = quantile

/** A series' identity, as the page computes it for the totals before a recording (the prelude
 *  runs this same function): the labels in key order, since the order of an object's keys does
 *  not survive Tilr Control (Control.swift's JSONSerialization makes them an NSDictionary). */
export const seriesKey = m =>
  m.name +
  JSON.stringify(
    Object.keys(m.labels ?? {})
      .sort()
      .map(k => [k, m.labels[k]]),
  )

/** A series keeps its latest METRIC_RING observations (src/performance.ts). */
export const METRIC_RING = 256

/** The series named `name` whose labels match `labels` (each given key equal). */
export function series(recording, name, labels = {}) {
  return (recording.metrics ?? []).filter(
    m => m.name === name && Object.entries(labels).every(([k, v]) => m.labels[k] === v),
  )
}

/** The observations inside the recording's window: `recent` (the latest 256 per series). */
export function observed(recording, list) {
  const values = []
  for (const m of list)
    for (const [t, v] of m.recent) if (t >= recording.started && t <= recording.ended) values.push(v)
  return values
}

/**
 * Count and sum of the series inside the recording's window. With `before` (series key → the
 * count and sum just before record(), what the page reads) exact: the recording's count / sum are
 * session totals; without it, from the per-second buckets that overlap the window (the first may
 * hold observations from just before it).
 */
export function totals(recording, list, before) {
  let count = 0,
    sum = 0
  for (const m of list) {
    if (before) {
      const b = before[seriesKey(m)] ?? { count: 0, sum: 0 }
      count += m.count - b.count
      sum += m.sum - b.sum
    } else {
      for (const [second, n, s] of m.seconds) {
        if ((second + 1) * 1000 > recording.started && second * 1000 <= recording.ended) {
          count += n
          sum += s
        }
      }
    }
  }
  return { count, sum }
}

/**
 * Whether the observations of `list` inside the recording are all there (`full`), or only the
 * latest 256 a series' ring kept (`tail`): with `before`, exact (more observations in the window,
 * by the totals, than `recent` has); without it, a full ring whose oldest entry is inside the
 * window after the series had more than 256.
 */
export function coverageOf(recording, list, before) {
  for (const m of list) {
    const inside = m.recent.filter(([t]) => t >= recording.started && t <= recording.ended).length
    if (before) {
      const b = before[seriesKey(m)] ?? { count: 0 }
      if (m.count - b.count > inside) return 'tail'
    } else if (m.count > METRIC_RING && m.recent.length >= METRIC_RING && m.recent[0][0] > recording.started)
      return 'tail'
  }
  return 'full'
}

/** p50 / p95 / max (ms, one decimal), how many observations they are of and their coverage. */
export function stat(values, coverage = 'full') {
  return {
    p50: ms(percentile(values, 0.5)),
    p95: ms(percentile(values, 0.95)),
    max: values.length ? ms(Math.max(...values)) : null,
    n: values.length,
    coverage,
  }
}

/** stat() of the observations of `list` inside the recording. */
const statOf = (recording, list, before) => stat(observed(recording, list), coverageOf(recording, list, before))

/** Per sample, the processes named `name` summed: CPU % (mean, max over the samples where every
 *  such process has one; the first sample has none) and memory bytes (last, max). */
export function processStats(samples, name) {
  const cpu = [],
    memory = []
  for (const s of samples) {
    const rows = (s.processes ?? []).filter(p => p.name === name)
    if (!rows.length) continue
    memory.push(rows.reduce((n, p) => n + p.memory, 0))
    if (rows.every(p => p.cpu !== null && p.cpu !== undefined)) cpu.push(rows.reduce((n, p) => n + p.cpu, 0))
  }
  return {
    cpu: {
      mean: cpu.length ? ms(cpu.reduce((a, b) => a + b, 0) / cpu.length) : null,
      max: cpu.length ? ms(Math.max(...cpu)) : null,
    },
    memory: { last: memory.length ? int(memory.at(-1)) : null, max: memory.length ? int(Math.max(...memory)) : null },
  }
}

/** FPS of the samples that have one (rAF cadence; null: no frame loop, or the page hidden). */
export function fpsStats(samples) {
  const values = samples.map(s => s.fps).filter(v => v !== null && v !== undefined)
  return { p50: ms(percentile(values, 0.5)), max: values.length ? ms(Math.max(...values)) : null, n: values.length }
}

const samplesOf = recording => recording.samples.filter(s => s.t >= recording.started && s.t <= recording.ended)
const pick = (stats, keys) => Object.fromEntries(keys.map(k => [k, stats[k]]))

/** The throughput scenario's numbers. `run`: { pane, before, wallMs, timedOut, size }. */
export function extractThroughput(recording, { pane, before, wallMs, timedOut = false, size }) {
  const of = name => series(recording, name, { pane })
  const frames = totals(recording, of('server.frame_bytes'), before)
  const draws = totals(recording, of('terminal.draw'), before)
  const samples = samplesOf(recording)
  const web = processStats(samples, 'WebContent'),
    app = processStats(samples, 'Tilr')
  return {
    size,
    wallMs: ms(wallMs),
    timedOut,
    frames: int(frames.count),
    bytes: int(frames.sum),
    rowsChanged: int(totals(recording, of('server.rows_changed'), before).sum),
    outputBytes: int(totals(recording, of('server.output_bytes'), before).sum),
    hops: Object.fromEntries(
      Object.entries(HOPS).map(([hop, name]) => [
        hop,
        pick(statOf(recording, of(name), before), ['p50', 'p95', 'n', 'coverage']),
      ]),
    ),
    framesPerPaint: pick(statOf(recording, of('terminal.frames_per_paint'), before), ['p50', 'n', 'coverage']),
    draws: int(draws.count),
    drawMs: ms(draws.sum),
    fps: fpsStats(samples),
    cpu: { webContent: web.cpu, tilr: app.cpu },
    durationMs: ms(recording.ended - recording.started),
  }
}

/** The typing scenario's numbers. `run`: { pane, server, before, keys, intervalMs, method }. */
export function extractTyping(
  recording,
  { pane, server, before, keys = TYPING_KEYS, intervalMs = TYPING_INTERVAL, method = 'keydown' },
) {
  const of = name => statOf(recording, series(recording, name, { pane }), before)
  return {
    keys,
    intervalMs,
    method,
    keyToFrame: of('terminal.key_to_frame'),
    keyToPaint: of('terminal.key_to_paint'),
    echo: of('terminal.echo'),
    rtt: statOf(recording, series(recording, 'server.rtt', server ? { server } : {}), before),
    input: of('server.input'),
    echoLost: int(totals(recording, series(recording, 'terminal.echo_lost', { pane }), before).count),
    durationMs: ms(recording.ended - recording.started),
  }
}

/** The idle scenario's numbers. `run`: { pane, before, seconds, sampleInterval }. */
export function extractIdle(recording, { pane, before, seconds, sampleInterval = 1000 }) {
  const samples = samplesOf(recording)
  const web = processStats(samples, 'WebContent'),
    app = processStats(samples, 'Tilr')
  const commits = samples.reduce((n, s) => n + s.commits, 0)
  const inputs = (recording.metrics ?? []).filter(m => m.name.startsWith('input.'))
  return {
    seconds,
    cpu: { webContent: web.cpu, tilr: app.cpu },
    memory: { webContent: web.memory, tilr: app.memory },
    reactCommitsPerSecond: samples.length ? ms(commits / ((samples.length * sampleInterval) / 1000)) : null,
    fps: fpsStats(samples),
    visible: samples.length ? samples.some(s => s.visible) : null,
    inputs: int(totals(recording, inputs, before).count),
    frames: int(totals(recording, series(recording, 'server.frame_bytes', { pane }), before).count),
    drawMs: ms(totals(recording, series(recording, 'terminal.draw', { pane }), before).sum),
    samples: samples.length,
    durationMs: ms(recording.ended - recording.started),
  }
}

// ---- comparison: pure, over two bench results ---------------------------------------------------

/** What `compare` reads, [path, label, unit]: higher is worse for every one. */
export const COMPARE_KEYS = [
  ['throughput.wallMs', 'throughput wall ms', 'ms'],
  ['throughput.bytes', 'throughput bytes', 'bytes'],
  ['throughput.frames', 'throughput frames', 'count'],
  ...Object.keys(HOPS).map(hop => [`throughput.hops.${hop}.p95`, `throughput ${hop} p95 ms`, 'ms']),
  ['throughput.drawMs', 'throughput draw total ms', 'ms'],
  ['typing.keyToPaint.p50', 'typing key_to_paint p50 ms', 'ms'],
  ['typing.keyToPaint.p95', 'typing key_to_paint p95 ms', 'ms'],
  ['typing.echo.p95', 'typing echo p95 ms', 'ms'],
  ['typing.rtt.p50', 'typing rtt p50 ms', 'ms'],
  ['idle.cpu.webContent.mean', 'idle WebContent CPU mean %', 'pct'],
  ['idle.cpu.tilr.mean', 'idle Tilr CPU mean %', 'pct'],
  ['idle.memory.webContent.max', 'idle WebContent memory bytes', 'bytes'],
]

/** From a zero baseline, B above this (per unit) is a regression: 1 ms, 1 MiB, 1 (CPU %), 1. */
export const ZERO_FLOOR = { ms: 1, bytes: 1048576, pct: 1, count: 1 }

/** What makes two results incomparable, [path, label]: a difference is a warning. */
const SAME = [
  ['scenarios.throughput.size', 'throughput size'],
  ['scenarios.idle.seconds', 'idle seconds'],
  ['scenarios.typing.method', 'typing method'],
  ['env.react', 'React build'],
  ['env.plugins.server', 'server plugin'],
  ['env.plugins.terminal', 'terminal plugin'],
  ['env.plugins.performance', 'performance plugin'],
  ['env.serverVersion', 'tilr-server'],
]

const at = (object, path) =>
  path.split('.').reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), object)

/**
 * `a` against `b` (bench results, version 1): a row per COMPARE_KEYS entry present in either,
 * Δ% = (b − a) / a; `regressed` when Δ% exceeds `threshold` (higher is worse). A number in `a`
 * that `b` lacks (null or missing) is a regression (`missing`); from 0 in `a`, B above the unit's
 * ZERO_FLOOR is one (`fromZero`, no Δ%); a key only in `b` has no Δ and does not count.
 * `warnings`: what differs between the runs (size, seconds, method, React build, versions).
 */
// eslint-disable-next-line complexity -- one branch per kind of difference between two runs (regression, fromZero, missing, warnings); the cases read best side by side
export function compareBench(a, b, { threshold = 10 } = {}) {
  const rows = []
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  for (const [path, label, unit] of COMPARE_KEYS) {
    const x = num(at(a?.scenarios, path)),
      y = num(at(b?.scenarios, path))
    if (x === null && y === null) continue
    const row = { key: path, label, a: x, b: y, delta: null, regressed: false }
    if (x !== null && y === null) Object.assign(row, { missing: true, regressed: true })
    else if (x === 0) Object.assign(row, { fromZero: true, regressed: y > ZERO_FLOOR[unit] })
    else if (x !== null) {
      const delta = ((y - x) / Math.abs(x)) * 100
      Object.assign(row, { delta: ms(delta), regressed: delta > threshold })
    }
    rows.push(row)
  }
  const warnings = []
  for (const [path, label] of SAME) {
    if (
      path.startsWith('scenarios.') &&
      (!at(a, path.split('.').slice(0, 2).join('.')) || !at(b, path.split('.').slice(0, 2).join('.')))
    )
      continue
    const x = at(a, path) ?? null,
      y = at(b, path) ?? null
    if (x !== y) warnings.push(`${label} differs: ${cell(x)} vs ${cell(y)}`)
  }
  return { threshold, rows, warnings, regressed: rows.some(r => r.regressed) }
}

const cell = v => (v === null || v === undefined ? '—' : String(v))
/** Rows as aligned columns: the first padded at the end, column i > 0 at the start when right(i). */
export function table(rows, right = () => true) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)))
  return rows
    .map(r =>
      r
        .map((c, i) => (i > 0 && right(i) ? c.padStart(widths[i]) : c.padEnd(widths[i])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/** compareBench() as a table: metric | A | B | Δ%, `!` after a regression; the warnings above it. */
export function compareText({ threshold, rows, warnings = [] }) {
  const head = warnings.map(w => `warning: ${w}`)
  if (!rows.length) return [...head, 'nothing to compare'].join('\n')
  const mark = r => (r.regressed ? ' !' : '')
  const delta = r =>
    r.missing
      ? `missing${mark(r)}`
      : r.fromZero
        ? r.regressed
          ? `from 0${mark(r)}`
          : '—'
        : r.delta === null
          ? '—'
          : `${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)}%${mark(r)}`
  const lines = table([['metric', 'A', 'B', 'Δ%'], ...rows.map(r => [r.label, cell(r.a), cell(r.b), delta(r)])])
  const bad = rows.filter(r => r.regressed).length
  return [
    ...head,
    lines,
    bad ? `${bad} regression${bad === 1 ? '' : 's'} beyond ${threshold}%` : `no regression beyond ${threshold}%`,
  ].join('\n')
}

/** A bench result as a short table for the terminal. */
// eslint-disable-next-line complexity -- a report formatter: one optional line per metric that may be absent from a run
export function benchText(result) {
  const { env = {}, scenarios = {} } = result
  const n = s => (s?.n === undefined ? '' : ` · n=${s.n}${s.coverage === 'tail' ? ' (tail)' : ''}`)
  const pair = s => (s ? `${cell(s.p50)} / ${cell(s.p95)}${n(s)}` : '—')
  const head = [
    `tilr ${cell(env.tilr)} · React ${cell(env.react)} · plugins server ${cell(env.plugins?.server)}, terminal ${cell(env.plugins?.terminal)} · tilr-server ${cell(env.serverVersion)} · ${cell(env.hardwareConcurrency)} cores`,
  ]
  const rows = [['scenario', 'metric', 'value']]
  const t = scenarios.throughput
  if (t) {
    rows.push(
      ['throughput', `wall ms (seq 1 ${t.size})`, `${cell(t.wallMs)}${t.timedOut ? ' (timed out)' : ''}`],
      ['', 'frames · bytes', `${cell(t.frames)} · ${cell(t.bytes)}`],
      ['', 'rows changed · output bytes', `${cell(t.rowsChanged)} · ${cell(t.outputBytes)}`],
      ...Object.keys(HOPS).map(hop => ['', `${hop} p50 / p95 ms`, pair(t.hops?.[hop])]),
      ['', 'frames per paint p50', `${cell(t.framesPerPaint?.p50)}${n(t.framesPerPaint)}`],
      ['', 'draws · draw total ms', `${cell(t.draws)} · ${cell(t.drawMs)}`],
      ['', 'FPS p50', cell(t.fps?.p50)],
      ['', 'WebContent CPU % mean / max', `${cell(t.cpu?.webContent?.mean)} / ${cell(t.cpu?.webContent?.max)}`],
      ['', 'Tilr CPU % mean', cell(t.cpu?.tilr?.mean)],
    )
  }
  const k = scenarios.typing
  if (k) {
    const three = s => (s ? `${cell(s.p50)} / ${cell(s.p95)} / ${cell(s.max)}${n(s)}` : '—')
    rows.push(
      ['typing', `keys (${k.keys} × ${k.intervalMs} ms, ${k.method})`, 'p50 / p95 / max ms'],
      ['', 'key_to_frame', three(k.keyToFrame)],
      ['', 'key_to_paint', three(k.keyToPaint)],
      ['', 'echo', three(k.echo)],
      ['', 'rtt', three(k.rtt)],
      ['', 'server input', three(k.input)],
      ['', 'echo lost', cell(k.echoLost)],
    )
  }
  const i = scenarios.idle
  if (i) {
    const mib = n => (n === null || n === undefined ? '—' : `${(n / 1048576).toFixed(1)} MiB`)
    rows.push(
      [
        'idle',
        `CPU % mean / max (${i.seconds} s)`,
        `WebContent ${cell(i.cpu?.webContent?.mean)} / ${cell(i.cpu?.webContent?.max)} · Tilr ${cell(i.cpu?.tilr?.mean)} / ${cell(i.cpu?.tilr?.max)}`,
      ],
      ['', 'memory max', `WebContent ${mib(i.memory?.webContent?.max)} · Tilr ${mib(i.memory?.tilr?.max)}`],
      ['', 'React commits/s', cell(i.reactCommitsPerSecond)],
      ['', 'FPS p50', `${cell(i.fps?.p50)}${i.visible ? ' (visible)' : ''}`],
      ['', 'inputs · frames · draw ms', `${cell(i.inputs)} · ${cell(i.frames)} · ${cell(i.drawMs)}`],
    )
  }
  if (result.error) head.push(`error: ${result.error} (a partial result: the scenarios before it)`)
  return `${head.join('\n')}\n${table(rows, () => false)}`
}

/** Where a result goes when no --out: `dir` (the debug status' recordings folder) or
 *  ~/.config/tilr/debug, `<prefix>-<timestamp>.json`. */
export function benchPath(dir, date = new Date(), prefix = 'bench') {
  const stamp = date
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-')
  return join(dir || join(homedir(), '.config', 'tilr', 'debug'), `${prefix}-${stamp}.json`)
}

/** Whether `line` (a screen line, trailing spaces trimmed as the terminal's agent text has
 *  them) looks like a shell prompt: it ends with `$`, `%`, `>`, `#` or `❯`. */
export function promptLine(line) {
  return /(?:[$%>#]|❯)$/.test(String(line ?? '').trimEnd())
}

// ---- the driver: through Tilr Control --------------------------------------------------------------

/** What the page runs first in every step: the bench window's agent (the terminal type's
 *  AgentAdapter), the Performance service, and helpers. */
const prelude = id => `
const id = ${JSON.stringify(id)}
const p = $.performance
const row = () => { const r = $.layout.get(id); if (!r) throw new Error('bench: the terminal window ' + id + ' is gone'); return r }
const type = $.windows.get('terminal')
if (!type?.agent?.text || !type.agent.input) throw new Error('bench: the terminal window type has no agent (plugin-terminal 0.8.3 or later)')
const text = () => type.agent.text(row())
const input = s => type.agent.input(row(), s)
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)))
const key = ${seriesKey.toString()}
const totals = () => Object.fromEntries(((p.series ? p.series() : p.snapshot()?.metrics) ?? []).map(m => [key(m), { count: m.count, sum: m.sum }]))
const strip = r => { if (!r) throw new Error('bench: the recording stopped on its own (60 s)'); return { ...r, events: [] } }
if (!('recording' in p)) throw new Error('bench: this Performance plugin is older than the tool (finish() returns no recording): update the site')
// persist: false: the bench's recordings do not replace the one saved in the window.
const record = () => { if (!p.enabled) throw new Error('bench: Performance collection is off'); if (p.recording) throw new Error('bench: a recording is in progress; stop it first'); p.record({ persist: false }) }
const screenOf = () => [...document.querySelectorAll('.window[data-window]')].find(el => el.getAttribute('data-window') === id)?.querySelector('.terminal-screen') ?? null
const keydown = (screen, key, mods = {}) => screen.dispatchEvent(new KeyboardEvent('keydown', { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true, ...mods }))
// Until the screen has text that stays the same for quietMs (a prompt).
const settle = async (timeoutMs = 20000, quietMs = 300) => {
  const end = performance.now() + timeoutMs
  let last = null, since = performance.now()
  for (;;) {
    let t = ''
    try { t = text() } catch {}
    const now = performance.now()
    if (t !== last) { last = t; since = now } else if (t.trim() && now - since >= quietMs) return t
    if (now > end) throw new Error('bench: the terminal shows no prompt after ' + timeoutMs + ' ms')
    await sleep(50)
  }
}
`

const OPEN = `
const focused = $.layout.list().find(r => r.focused)?.id ?? null
const id = $.layout.open({ type: 'terminal', mode: 'float', rect: { width: 960, height: 600 } })
return { id, focused }`

const ENV = `
await settle()
const r = row()
const config = r.config ?? {}
let conn = null
try { conn = (config.server && $.server.get(config.server)) || $.server.default() } catch {}
const plugins = $.plugins.list()
const version = name => plugins.find(x => x.name === name)?.version ?? null
return {
  pane: config.pane ?? null, server: conn?.id ?? config.server ?? null, sampleInterval: p.sampleInterval ?? 1000,
  env: {
    tilr: tilr.version ?? tilr.api ?? null, react: tilr.react ?? null,
    plugins: { server: version('server'), terminal: version('terminal'), performance: version('performance') },
    serverVersion: conn?.state?.serverVersion ?? null,
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    devicePixelRatio: globalThis.devicePixelRatio ?? null, visible: document.visibilityState === 'visible',
    window: { rect: r.rect ? { width: Math.round(r.rect.width), height: Math.round(r.rect.height) } : null, mode: r.mode },
  },
}`

const THROUGHPUT = (size, timeoutMs) => `
await settle()
input('clear\\n'); await sleep(100); await settle()
const before = totals()
record()
const t0 = performance.now()
// The marker is split by quotes in the command, so only the output has it whole.
input(${JSON.stringify(`seq 1 ${size}; echo ${MARKER.slice(0, 12)}''${MARKER.slice(12)}\n`)})
const done = /^${MARKER}\\s*$/m
let timedOut = false
for (;;) {
  if (done.test(text())) break
  if (performance.now() - t0 > ${timeoutMs}) { timedOut = true; break }
  await sleep(50)
}
const wallMs = performance.now() - t0
await sleep(200)
const recording = strip(p.finish())
if (timedOut) {
  // Ctrl-C ends the seq still running, then the prompt comes back.
  const screen = screenOf()
  if (screen) keydown(screen, 'c', { ctrlKey: true }); else input('\\x03')
  await sleep(200); await settle(30000)
}
input('clear\\n'); await sleep(100); await settle()
return { before, wallMs, timedOut, recording }`

const TYPING = (keys, interval) => `
await settle()
const screen = screenOf()
// A keydown on the screen goes the keyboard's way (keyPress, the key's seq, key → paint);
// without the element, the agent's input (a paste: no key metrics, the echo only).
const method = screen ? 'keydown' : 'paste'
const press = key => keydown(screen, key)
const before = totals()
record()
const t0 = performance.now()
for (let i = 0; i < ${keys}; i++) {
  if (screen) press('x'); else input('x')
  await sleep(t0 + (i + 1) * ${interval} - performance.now())
}
if (screen) press('Enter'); else input('\\n')
await sleep(500)
const recording = strip(p.finish())
input('clear\\n'); await sleep(100); await settle()
return { before, method, recording }`

const IDLE_START = `
await settle()
const before = totals()
record()
return { before }`

const IDLE_END = `return { recording: strip(p.finish()) }`

const CLOSE = focused => `
try { input('exit\\n') } catch {}
const end = performance.now() + 3000
while ($.layout.get(id) && performance.now() < end) await sleep(50)
const closed = !$.layout.get(id)
if (!closed) $.layout.close(id)
const focused = ${JSON.stringify(focused)}
if (focused && $.layout.get(focused)) $.layout.focus(focused)
return { exited: closed }`

/** An error `tilr` exits with `exitCode`. */
export class BenchError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The screen of a window the bench did not open: its last non-empty line once the text stayed
 *  the same for 300 ms (3 s at most), and whether it did. */
const PROMPT = `
const t0 = performance.now()
let last = null, since = t0
for (;;) {
  let t = ''
  try { t = text() } catch {}
  const now = performance.now()
  if (t !== last) { last = t; since = now } else if (now - since >= 300) break
  if (now - t0 > 3000) break
  await sleep(50)
}
const line = (last ?? '').split('\\n').map(l => l.trimEnd()).filter(Boolean).at(-1) ?? ''
return { line, stable: performance.now() - since >= 300 }`

/**
 * Runs `scenarios` against a terminal window: `window` (an id, which must show a shell prompt;
 * else a fresh floating 960 × 600 one, closed at the end, its shell exited) and answers the
 * result, version 1: `{ version, when, env, scenarios }`. Each scenario lands in `scenarios` as
 * it completes; a failure after the first step is not thrown but answered as `error` beside the
 * scenarios done (the caller writes the partial result and exits non-zero). `log` is told each
 * step.
 */
// eslint-disable-next-line complexity -- the bench driver, a linear script of optional steps (scenarios, recording, cleanup); the pure parts are split out and tested
export async function runBench({
  scenarios = SCENARIOS,
  seconds = 10,
  size = 200_000,
  window,
  socket,
  app,
  log = () => {},
} = {}) {
  const options = { ...(socket !== undefined ? { socket } : {}), ...(app ? { app } : {}) }
  const status = await debug('status', {}, { socket, app })
  if (!status.enabled) throw new BenchError('Performance collection is off: run `tilr ctl debug on` first', 2)
  if (status.recording) throw new BenchError('a `tilr ctl debug record` is in progress')
  for (const s of scenarios)
    if (!SCENARIOS.includes(s)) throw new BenchError(`no scenario ${JSON.stringify(s)}: ${SCENARIOS.join(', ')} or all`)
  if (!(seconds > 0 && seconds <= MAX_SECONDS))
    throw new BenchError(`--seconds is in (0, ${MAX_SECONDS}] (a recording stops at 60 s)`)
  if (!(Number.isInteger(size) && size > 0)) throw new BenchError('--size is a positive integer')
  const page = (id, js, timeout = 60_000) => evaluate(prelude(id) + js, { ...options, timeout })
  if (window) {
    // Typing into whatever runs there (an editor, a pager) would do harm: a shell prompt only.
    const { line, stable } = await page(window, PROMPT, 20_000)
    if (!stable || !promptLine(line))
      throw new BenchError(
        `the window does not show a shell prompt (its last line: ${JSON.stringify(line)}${stable ? '' : ', still changing'})`,
        2,
      )
  }
  let id = window,
    focused = null
  if (!id) {
    log('opening a terminal window')
    ;({ id, focused } = await evaluate(OPEN, options))
  }
  const result = { version: 1, when: new Date().toISOString(), env: null, scenarios: {} }
  try {
    const info = await page(id, ENV, 40_000)
    if (!info.pane) throw new BenchError(`the terminal window ${id} has no pane`)
    result.env = { ...info.env, window: { ...info.env.window, id, opened: !window } }
    const { pane, server, sampleInterval } = info
    // Quietest first: the heavy output last, so it does not leave work behind for the others.
    for (const scenario of ['idle', 'typing', 'throughput'].filter(s => scenarios.includes(s))) {
      log(`${scenario}…`)
      if (scenario === 'idle') {
        const { before } = await page(id, IDLE_START)
        await sleep(seconds * 1000)
        const { recording } = await page(id, IDLE_END)
        result.scenarios.idle = extractIdle(recording, { pane, before, seconds, sampleInterval })
      } else if (scenario === 'typing') {
        const run = await page(id, TYPING(TYPING_KEYS, TYPING_INTERVAL), 60_000)
        result.scenarios.typing = extractTyping(run.recording, {
          pane,
          server,
          before: run.before,
          keys: TYPING_KEYS,
          intervalMs: TYPING_INTERVAL,
          method: run.method,
        })
      } else {
        const timeoutMs = MAX_SECONDS * 1000
        const run = await page(id, THROUGHPUT(size, timeoutMs), timeoutMs + 90_000)
        result.scenarios.throughput = extractThroughput(run.recording, {
          pane,
          before: run.before,
          wallMs: run.wallMs,
          timedOut: run.timedOut,
          size,
        })
      }
      await sleep(1000)
    }
  } catch (error) {
    result.error = error.message
    log(`failed: ${error.message}`)
    // A recording of ours may still run (the bench refused to start beside another one).
    await evaluate('const p = $.performance; if (p?.recording) p.finish(); return null', options).catch(() => {})
  } finally {
    if (!window) {
      log('closing the terminal window')
      await page(id, CLOSE(focused), 20_000).catch(() =>
        evaluate(`$.layout.close(${JSON.stringify(id)})`, options).catch(() => {}),
      )
    }
  }
  return { result, dir: status.dir ?? null }
}

/** Writes `result` to `out` (else benchPath(dir)) and answers the path. */
export async function writeBench(result, { out, dir } = {}) {
  const path = out ?? benchPath(dir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(result, null, 2) + '\n')
  return path
}
