// `tilr ctl debug memory`: is memory growth a leak or normal, and where? Every `interval` seconds
// the Performance service's probe() (process memory from the native sampler, windows, DOM nodes,
// Cordis listeners per plugin, React roots, canvases, images: counts only) is read through Tilr
// Control; at the end each process' series is judged (slope, drawdowns, a verdict) and the counts
// compared first to last. Where the Mac app can, each probe also reads the native footprint by
// category (malloc, graphics, js, jit, other), and the run squeezes WebKit (asks it to release
// what it can) after the first probe and at the end: memory a squeeze gives back is caches and
// garbage, memory that stays from one squeeze to the next is retained. The analysis is pure over
// the probes (tools/memory.test.mjs); runMemory() is the driver.
import { debug, debugNative, evaluate } from './control.mjs'
import { BenchError, benchPath } from './bench.mjs'

const MIB = 1048576
/** Slope (MiB/min) at or above which a series grows. */
export const GROWING = 0.5
/** A drop after a peak of at least this share of the peak counts as a drawdown (a collection). */
export const DRAWDOWN = 0.05
/** Retained memory (between the squeezes) or reclaimed memory (peak − after the squeeze) counts
 *  from this many bytes, or this share of its base, whichever is larger. */
export const RETAINED_BYTES = 10 * MIB
export const RETAINED_SHARE = 0.05
/** The categories of footprint(). */
export const CATEGORIES = ['malloc', 'graphics', 'js', 'jit', 'other']

const round = (n, digits = 2) => n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits

/** Least-squares slope of `points` ([ms, bytes]) in MiB per minute; null under 2 points or 0 time. */
export function slope(points) {
  const n = points.length
  if (n < 2) return null
  let mx = 0, my = 0
  for (const [x, y] of points) { mx += x; my += y }
  mx /= n; my /= n
  let num = 0, den = 0
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2 }
  return den ? num / den * 60_000 / MIB : null
}

/** The largest drop after a peak, as a share of that peak (0…1): max over i of
 *  (max(v[0..i]) − v[i]) / max(v[0..i]). */
export function maxDrawdown(values) {
  let peak = -Infinity, worst = 0
  for (const v of values) {
    if (v > peak) peak = v
    else if (peak > 0) worst = Math.max(worst, (peak - v) / peak)
  }
  return worst
}

/**
 * The drawdowns of at least `threshold` (a share of the peak): each a fall from a local high
 * that reaches `threshold` below it, ended when the series climbs back by half the threshold
 * (of the high) from its low. In order, `{ depth: (high − low) / high, low: the low's index }`.
 */
export function drawdowns(values, threshold = DRAWDOWN) {
  const out = []
  if (!values.length) return out
  let falling = false, high = values[0], low = values[0], at = 0
  for (let i = 1; i < values.length; i++) {
    const v = values[i]
    if (!falling) {
      if (v > high) high = v
      else if (high > 0 && (high - v) / high >= threshold) { falling = true; low = v; at = i }
    } else if (v < low) { low = v; at = i }
    else if (v - low >= high * threshold / 2) { out.push({ depth: (high - low) / high, low: at }); falling = false; high = v }
  }
  if (falling) out.push({ depth: (high - low) / high, low: at })
  return out
}

/**
 * A process' memory over time, `points` [ms, bytes] in order: first / last / min / max (bytes),
 * slope (MiB/min, least squares), floorSlope (with two or more drawdowns, the slope of their
 * lows: the level after each collection, MiB/min), maxDrawdown (% of the peak), drawdowns (how
 * many ≥ 5 %), the first and the last third's slopes, and a verdict:
 * - `plateau`: it grew, then stopped (the last third's slope under 10 % of the first's), with at
 *   least one drawdown: a cache or a heap that found its size.
 * - `gc-sawtooth`: two or more drawdowns and a trend under 0.5 MiB/min: allocation and
 *   collection, normal.
 * - `growing`: a slope of 0.5 MiB/min or more and no drawdown: nothing is given back, a leak
 *   candidate.
 * - `growing-sawtooth`: drawdowns, but a trend of 0.5 MiB/min or more: collections run, the
 *   floor rises.
 * - `flat`: none of these (under 0.5 MiB/min).
 * - `too-short`: under 6 points.
 * The trend is floorSlope when there is one, else slope: a sawtooth's least-squares slope says
 * more about where the window cut it (ending on a peak or after a collection) than about a trend.
 */
export function judge(points) {
  const values = points.map(([, v]) => v)
  const downs = drawdowns(values)
  const floor = downs.length >= 2 ? slope(downs.map(d => points[d.low])) : null
  const out = {
    first: values[0] ?? null, last: values.at(-1) ?? null,
    min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
    slope: round(slope(points)), floorSlope: round(floor), maxDrawdown: round(maxDrawdown(values) * 100, 1), drawdowns: downs.length,
    thirds: { first: null, last: null }, verdict: 'too-short',
  }
  if (points.length < 6) return out
  const third = Math.floor(points.length / 3)
  const early = slope(points.slice(0, third + 1)), late = slope(points.slice(points.length - third - 1))
  out.thirds = { first: round(early), last: round(late) }
  const trend = floor ?? slope(points)
  if (early > 0 && late < early * 0.1 && downs.length >= 1) out.verdict = 'plateau'
  else if (downs.length >= 2 && trend < GROWING) out.verdict = 'gc-sawtooth'
  else if (trend >= GROWING && downs.length === 0) out.verdict = 'growing'
  else if (trend >= GROWING) out.verdict = 'growing-sawtooth'
  else out.verdict = 'flat'
  return out
}

/** first / last / Δ of a count over the probes. */
const counter = values => {
  const list = values.filter(v => typeof v === 'number')
  return { first: list[0] ?? null, last: list.at(-1) ?? null, delta: list.length ? list.at(-1) - list[0] : null }
}

/**
 * The verdict once squeezes happened: `leak-suspect` when the memory left after the last squeeze
 * exceeds what was left after the first by max(10 MiB, 5 % of the first), `cache-only` when that
 * stays under it but the peak was max(10 MiB, 5 % of the peak) above what the last squeeze left
 * (the growth comes back when asked), else `trend` (judge()'s). Without two squeezes: `trend`.
 */
export function squeezeVerdict({ peak, afterSqueeze, retained }, trend) {
  if (retained === null || retained === undefined || !afterSqueeze) return trend
  if (retained >= Math.max(RETAINED_BYTES, afterSqueeze.first * RETAINED_SHARE)) return 'leak-suspect'
  if (peak - afterSqueeze.last >= Math.max(RETAINED_BYTES, peak * RETAINED_SHARE)) return 'cache-only'
  return trend
}

/**
 * Per process (by pid) of the footprints (`{ at, phase?, processes }`, phase 'squeeze' for those
 * read after a squeeze): the reading at its peak (the largest footprint outside the squeezes),
 * the last one after a squeeze, their Δ per category, and the largest category at the peak.
 */
export function categoryReport(footprints = []) {
  const byPid = new Map()
  for (const f of footprints) {
    for (const p of f.processes ?? []) {
      let row = byPid.get(p.pid)
      if (!row) { row = { role: p.role, pid: p.pid, scope: p.scope, peak: null, afterSqueeze: null }; byPid.set(p.pid, row) }
      const reading = { at: f.at, footprint: p.footprint, reclaimable: p.reclaimable ?? 0, categories: Object.fromEntries(CATEGORIES.map(c => [c, p.categories?.[c] ?? 0])) }
      if (f.phase === 'squeeze') row.afterSqueeze = reading
      else if (!row.peak || p.footprint > row.peak.footprint) row.peak = reading
    }
  }
  return [...byPid.values()].map(row => {
    const peak = row.peak ?? row.afterSqueeze
    const after = row.afterSqueeze
    const delta = peak && after && row.peak ? Object.fromEntries(['footprint', ...CATEGORIES].map(k => [k, (k === 'footprint' ? after.footprint - peak.footprint : after.categories[k] - peak.categories[k])])) : null
    const dominant = CATEGORIES.reduce((a, b) => peak.categories[b] > peak.categories[a] ? b : a)
    return { ...row, peak, delta, dominant }
  })
}

const VERDICT = {
  'leak-suspect': 'what a squeeze cannot reclaim grew from the first squeeze to the last: a leak suspect',
  'cache-only': 'the growth comes back when WebKit is asked (squeeze): caches and uncollected garbage, not a leak',
  plateau: 'grew, then levelled off: a cache or heap that reached its size (normal)',
  'gc-sawtooth': 'allocates and collects, no trend (normal)',
  growing: 'grows and never gives memory back: a leak candidate',
  'growing-sawtooth': 'collections run but the floor keeps rising: a leak candidate',
  flat: 'no significant growth',
  'too-short': 'too few probes to tell (run longer)',
}

/**
 * The probes (`{ at, processes, windows, domNodes, listeners, reactRoots, canvases, images }`,
 * `at` ms since the start) judged: per process (by role and pid) judge() of its memory, the
 * counts first / last / Δ, the plugins whose listeners grew (most first), and hints.
 */
export function analyzeMemory(probes, { footprints = [] } = {}) {
  const byProcess = new Map()
  for (const p of probes) {
    for (const proc of p.processes ?? []) {
      const key = `${proc.role} ${proc.pid}`
      let row = byProcess.get(key)
      if (!row) { row = { role: proc.role, pid: proc.pid, scope: proc.scope, points: [], squeezed: [] }; byProcess.set(key, row) }
      row.scope = proc.scope
      ;(p.phase === 'squeeze' ? row.squeezed : row.points).push([p.at, proc.memory])
    }
  }
  const processes = [...byProcess.values()].map(({ points, squeezed, ...row }) => {
    const judged = judge(points)
    const all = [...points, ...squeezed].map(([, v]) => v)
    const peak = all.length ? Math.max(...all) : null
    const afterSqueeze = squeezed.length ? { first: squeezed[0][1], last: squeezed.at(-1)[1] } : null
    const two = squeezed.length >= 2
    const minutes = two ? (squeezed.at(-1)[0] - squeezed[0][0]) / 60_000 : 0
    const retained = two ? afterSqueeze.last - afterSqueeze.first : null
    const squeeze = { peak, afterSqueeze, retained, retainedSlope: two && minutes > 0 ? round(retained / MIB / minutes) : null, reclaimed: afterSqueeze && peak !== null ? peak - afterSqueeze.last : null }
    return { ...row, samples: points.length, ...judged, ...squeeze, trend: judged.verdict, verdict: squeezeVerdict(squeeze, judged.verdict) }
  })
  const categories = categoryReport(footprints)
  const counts = {}
  for (const key of ['listeners', 'domNodes', 'windows', 'reactRoots', 'canvases', 'images']) {
    counts[key] = counter(probes.map(p => key === 'listeners' ? p.listeners?.total : p[key]))
  }
  const firstPlugins = probes[0]?.listeners?.byPlugin ?? {}, lastPlugins = probes.at(-1)?.listeners?.byPlugin ?? {}
  const listeners = [...new Set([...Object.keys(firstPlugins), ...Object.keys(lastPlugins)])]
    .map(plugin => ({ plugin, first: firstPlugins[plugin] ?? 0, last: lastPlugins[plugin] ?? 0 }))
    .map(r => ({ ...r, delta: r.last - r.first }))
    .filter(r => r.delta !== 0)
    .sort((a, b) => b.delta - a.delta || a.plugin.localeCompare(b.plugin))
  return { processes, counts, listeners, categories, hints: [...hints(processes, counts, listeners), ...categoryHints(categories)] }
}

/** Hints from the categories: graphics dominating (compositing), malloc a squeeze gives back. */
function categoryHints(categories) {
  const out = []
  const mib = n => (n / MIB).toFixed(1)
  for (const c of categories) {
    const peak = c.peak, after = c.afterSqueeze
    if (c.dominant === 'graphics' && peak.categories.graphics >= peak.footprint * 0.3) {
      const kept = after && c.delta ? `; after the squeeze ${mib(after.categories.graphics)} MiB (${c.delta.graphics >= 0 ? '+' : ''}${mib(c.delta.graphics)}): a squeeze does not free it` : ''
      out.push(`${c.role} ${c.pid}: graphics is the largest part, ${mib(peak.categories.graphics)} of ${mib(peak.footprint)} MiB${kept}: compositing layers/tiles: open Safari Web Inspector → Layers; \`tilr ctl debug inspect\` (look for many or large composited layers: will-change, transforms, fixed or scrolling elements, big canvases)`)
    }
    if (c.dominant === 'malloc' && after && c.delta && -c.delta.malloc >= Math.max(RETAINED_BYTES, peak.categories.malloc * 0.25)) {
      out.push(`${c.role} ${c.pid}: malloc ${mib(peak.categories.malloc)} → ${mib(after.categories.malloc)} MiB after the squeeze: uncollected garbage, not a leak (WebKit returns it only under memory pressure)`)
    }
  }
  return out
}

const leaking = p => p.verdict === 'growing' || p.verdict === 'growing-sawtooth' || p.verdict === 'leak-suspect'
/** DOM nodes grew: more than 5 % and at least 50 nodes. */
const domGrew = c => c.first !== null && c.delta !== null && c.delta >= 50 && c.delta > c.first * 0.05

function hints(processes, counts, listeners) {
  const out = []
  const grown = listeners.filter(r => r.delta > 0)
  if (grown.length) out.push(`listeners grew (${counts.listeners.first} → ${counts.listeners.last}): ${grown.slice(0, 3).map(r => `${r.plugin} +${r.delta}`).join(', ')}: a plugin subscribes (ctx.on) per window or per update and does not dispose; check its effects`)
  if (domGrew(counts.domNodes) && !counts.windows.delta) out.push(`DOM leak: ${counts.domNodes.delta} more DOM nodes (${counts.domNodes.first} → ${counts.domNodes.last}) with the same number of windows: elements kept or appended and never removed (closed windows' content, a growing list, overlays)`)
  if (counts.reactRoots.delta > 0 && !(counts.windows.delta > 0)) out.push(`React roots grew by ${counts.reactRoots.delta} with no more windows: a createRoot() without unmount()`)
  const quiet = !(counts.listeners.delta > 0) && !domGrew(counts.domNodes) && !counts.windows.delta && !(counts.reactRoots.delta > 0)
  for (const p of processes.filter(leaking)) {
    if (p.role === 'WebContent' && quiet) out.push(`WebContent ${p.pid} grows (${p.slope} MiB/min) while listeners, DOM nodes, windows and React roots stay flat: the JS heap (closures, caches, arrays kept by a plugin). Take two heap snapshots a minute apart in Safari Web Inspector → Timelines → JavaScript Allocations and compare them; \`footprint ${p.pid}\` shows the process' memory by kind`)
    else if (/pane|server/i.test(p.role)) out.push(`${p.role} ${p.pid} grows (${p.slope} MiB/min): scrollback, normal up to the server's scrollback limit`)
    else if (p.role === 'Tilr') out.push(`Tilr ${p.pid} (the native app) grows (${p.slope} MiB/min): native views or the shell itself; \`footprint ${p.pid}\``)
  }
  return out
}

/** The probes' JSON and analysis as text: a process table, the counts, a verdict line per
 *  process and the hints. */
const mib = n => n === null || n === undefined ? '—' : (n / MIB).toFixed(1)
const signed = (n, f = String) => n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${f(n)}`
/** Rows as aligned columns: the first `left` padded at the end, the rest at the start. */
const grid = (rows, left = 2) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)))
  return rows.map(r => r.map((c, i) => i < left ? c.padEnd(widths[i]) : c.padStart(widths[i])).join('  ').trimEnd()).join('\n')
}
const NA = 'n/a (update the Mac app)'
/** What a squeeze may reach beyond Tilr. */
const SYSTEM_WIDE = 'a squeeze may be system-wide (a low-memory signal): other apps can release memory too'

/** categoryReport() rows as a table: per process its footprint and categories at the peak, after
 *  the squeeze and their Δ (MiB). */
export function categoriesText(categories) {
  if (!categories.length) return 'no footprint'
  const rows = [['footprint MiB', 'pid', 'when', 'total', ...CATEGORIES]]
  for (const c of categories) {
    const line = (name, r) => [name === 'peak' ? `${c.role} / ${c.scope}` : '', name === 'peak' ? String(c.pid) : '', name, mib(r.footprint), ...CATEGORIES.map(k => mib(r.categories[k]))]
    rows.push(line(c.afterSqueeze && c.peak === c.afterSqueeze ? 'after squeeze' : 'peak', c.peak))
    if (c.afterSqueeze && c.delta) {
      rows.push(line('after squeeze', c.afterSqueeze))
      rows.push(['', '', 'Δ', signed(c.delta.footprint, mib), ...CATEGORIES.map(k => signed(c.delta[k], mib))])
    }
  }
  return grid(rows, 3)
}

/** The probes' JSON and analysis as text: a process table, the squeezes and what stayed, the
 *  categories, the counts, a verdict line per process and the hints. */
export function memoryText({ seconds, interval, probes = [], footprints = [], squeezes = [], support, squeeze, report, error }) {
  const lines = [`${probes.filter(p => p.phase !== 'squeeze').length} probes, every ${interval} s over ${seconds} s`]
  const cell = v => v === null || v === undefined ? '—' : String(v)
  if (report?.processes.length) {
    lines.push('', grid([['process', 'pid', 'first MiB', 'last', 'min', 'max', 'MiB/min', 'floor MiB/min', 'max drawdown %', 'drawdowns', 'verdict'],
      ...report.processes.map(p => [`${p.role} / ${p.scope}`, String(p.pid), mib(p.first), mib(p.last), mib(p.min), mib(p.max), cell(p.slope), cell(p.floorSlope), cell(p.maxDrawdown), String(p.drawdowns), p.verdict])]))
  } else lines.push('', 'no process samples (the native sampler answers only in the Mac app)')
  if (squeezes.length) {
    lines.push('')
    squeezes.forEach((s, i) => lines.push(`squeeze ${i + 1} at ${Math.round(s.at / 1000)} s (${s.method || 'native'}): WebContent ${mib(s.before)} → ${mib(s.after)} MiB`))
    lines.push(`(${SYSTEM_WIDE})`)
    if (report?.processes.some(p => p.afterSqueeze)) {
      lines.push('', grid([['after squeeze', 'pid', 'peak MiB', 'first', 'last', 'retained', 'retained MiB/min', 'reclaimed', 'trend'],
        ...report.processes.filter(p => p.afterSqueeze).map(p => [`${p.role} / ${p.scope}`, String(p.pid), mib(p.peak), mib(p.afterSqueeze.first), mib(p.afterSqueeze.last), signed(p.retained, mib), cell(p.retainedSlope), mib(p.reclaimed), p.trend])]))
    }
  } else if (squeeze === false) lines.push('', 'squeeze: off (--no-squeeze)')
  else if (support?.squeeze === false) lines.push('', `squeeze: ${NA}`)
  if (footprints.length && report?.categories?.length) lines.push('', categoriesText(report.categories))
  else if (support?.footprint === false) lines.push('', `categories: ${NA}`)
  if (report) {
    lines.push('', grid([['count', '', 'first', 'last', 'Δ'], ...Object.entries(report.counts).map(([k, c]) => [k, '', cell(c.first), cell(c.last), c.delta === null ? '—' : `${c.delta > 0 ? '+' : ''}${c.delta}`])]))
    lines.push('')
    for (const p of report.processes) lines.push(`${p.role} ${p.pid}: ${p.verdict}: ${VERDICT[p.verdict]}`)
    for (const h of report.hints) lines.push(`hint: ${h}`)
  }
  if (error) lines.push(`error: ${error} (a partial result)`)
  return lines.join('\n')
}

export const PROBE = `if (!("performance" in $)) throw new Error('Install and enable the Performance web plugin first.')
const p = $.performance
if (typeof p.probe !== 'function') throw new Error('this Performance plugin has no probe(): update the site')
return p.probe()`
const NEEDS_PLUGIN = `if (!("performance" in $)) throw new Error('Install and enable the Performance web plugin first.')
const p = $.performance`
/** The page's footprint() / squeeze() / inspector(): null (inspect: { shown: false }) from a
 *  plugin without them. */
export const FOOTPRINT = `${NEEDS_PLUGIN}\nreturn typeof p.footprint === 'function' ? p.footprint() : null`
export const SQUEEZE = `${NEEDS_PLUGIN}\nreturn typeof p.squeeze === 'function' ? p.squeeze() : null`
export const INSPECT = `${NEEDS_PLUGIN}\nif (typeof p.inspector !== 'function') return { shown: false, reason: 'the Performance plugin has no inspector(): update the site' }
return p.inspector().then(shown => shown ? { shown } : { shown, reason: 'the Mac app did not open it (update the Mac app)' })`

/** A footprint reply by its shape (`{ processes: [...] }`), else null (undefined, an older app). */
export function footprintOf(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.processes)) return null
  return { processes: value.processes.filter(p => p && typeof p.footprint === 'number'), took: value.took ?? null, ...(typeof value.error === 'string' ? { error: value.error } : {}) }
}
/** A squeeze reply by its shape (`{ method, before, after }`), else null. */
export function squeezeOf(value) {
  if (!value || typeof value !== 'object' || typeof value.before !== 'number' || typeof value.after !== 'number') return null
  return { method: typeof value.method === 'string' ? value.method : '', before: value.before, after: value.after }
}

/** `tilr ctl debug footprint`: the Mac app's own, else the page's; null where neither can. */
export async function debugFootprint(options = {}) {
  return footprintOf(await debugNative('footprint', FOOTPRINT, { timeout: 15_000, ...options }))
}
/** `tilr ctl debug squeeze`: the Mac app's own, else the page's; null where neither can. */
export async function debugSqueeze(options = {}) {
  return squeezeOf(await debugNative('squeeze', SQUEEZE, { timeout: 30_000, ...options }))
}
/** `tilr ctl debug inspect`: `{ shown, reason? }`. */
export async function debugInspect(options = {}) {
  const reply = await debugNative('inspect', INSPECT, options)
  return reply && typeof reply.shown === 'boolean' ? reply : { shown: false, reason: NA }
}

/** A footprint reply as a table (MiB): per process its total, categories and reclaimable. */
export function footprintText(reply) {
  if (!reply) return `footprint: ${NA}`
  const rows = [['process', 'pid', 'footprint MiB', ...CATEGORIES, 'reclaimable'],
    ...reply.processes.map(p => [`${p.role} / ${p.scope}`, String(p.pid), mib(p.footprint), ...CATEGORIES.map(k => mib(p.categories?.[k] ?? 0)), mib(p.reclaimable ?? 0)])]
  const lines = [reply.processes.length ? grid(rows) : 'no processes']
  if (reply.took !== null && reply.took !== undefined) lines.push(`took ${Math.round(reply.took)} ms`)
  if (reply.error) lines.push(`error: ${reply.error}`)
  return lines.join('\n')
}
/** A squeeze reply as a line, with the system-wide caveat. */
export function squeezeText(reply) {
  if (!reply) return `squeeze: ${NA}`
  return `squeeze (${reply.method || 'native'}): WebContent ${mib(reply.before)} → ${mib(reply.after)} MiB (${signed(reply.after - reply.before, mib)})\n(${SYSTEM_WIDE})`
}
export const inspectText = reply => reply.shown ? 'Web Inspector opened' : `Web Inspector not shown${reply.reason ? `: ${reply.reason}` : ''}`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Probes the page every `interval` s for `seconds` s and answers `{ result, dir }`: result is
 * `{ version: 1, when, seconds, interval, squeeze, support, probes, footprints, squeezes, report }`
 * (report: analyzeMemory()), with `error` when a probe failed midway (the probes before it are
 * kept). Each probe also reads footprint() while the page's bridge answers it (`support.footprint`).
 * `squeeze` (on by default): after the first probe and after the last, squeeze(), `settle` ms,
 * then a probe and a footprint marked `phase: 'squeeze'`. Collection must be on (exit 2): the
 * process samples come from the native sampler only while it runs. `page` is the page's side
 * (`debug`, `evaluate`), replaced in tests.
 */
export async function runMemory({ seconds = 120, interval = 5, squeeze = true, settle = 3000, socket, app, log = () => {}, now = () => Date.now(), wait = sleep, page = { debug, evaluate } } = {}) {
  if (!(seconds > 0)) throw new BenchError('--seconds is a positive number')
  if (!(interval > 0 && interval <= seconds)) throw new BenchError('--interval is a positive number, at most --seconds')
  const options = { ...(socket !== undefined ? { socket } : {}), ...(app ? { app } : {}), timeout: 10_000 }
  const status = await page.debug('status', {}, { socket, app })
  if (!status.enabled) throw new BenchError('Performance collection is off: run `tilr ctl debug on` first (process memory is sampled only while collecting)', 2)
  const result = { version: 1, when: new Date(now()).toISOString(), seconds, interval, squeeze, support: { footprint: null, squeeze: squeeze ? null : false }, probes: [], footprints: [], squeezes: [], report: null }
  const start = now()
  const sample = async phase => {
    const probe = await page.evaluate(PROBE, options)
    if (!probe) throw new BenchError('Performance collection stopped during the run', 2)
    result.probes.push({ at: now() - start, ...(phase ? { phase } : {}), ...probe })
    if (result.support.footprint === false) return probe
    // The first answer tells whether the Mac app has it; a later miss is skipped.
    const footprint = footprintOf(await page.evaluate(FOOTPRINT, { ...options, timeout: 15_000 }))
    if (!footprint) {
      if (result.support.footprint === null) { result.support.footprint = false; log(`footprint: ${NA}: no categories`) }
    } else {
      result.support.footprint = true
      result.footprints.push({ at: now() - start, ...(phase ? { phase } : {}), ...footprint })
    }
    return probe
  }
  const squeezeNow = async () => {
    if (!squeeze || result.support.squeeze === false) return
    const reply = squeezeOf(await page.evaluate(SQUEEZE, { ...options, timeout: 30_000 }))
    if (!reply) { result.support.squeeze = false; log(`squeeze: ${NA}`); return }
    result.support.squeeze = true
    result.squeezes.push({ at: now() - start, ...reply })
    log(`squeeze (${reply.method || 'native'}): WebContent ${mib(reply.before)} → ${mib(reply.after)} MiB; probing again in ${settle / 1000} s`)
    await wait(settle)
    await sample('squeeze')
  }
  try {
    for (let i = 0; ; i++) {
      const due = start + i * interval * 1000
      if (due - start > seconds * 1000) break
      await wait(Math.max(0, due - now()))
      const probe = await sample()
      if (i % Math.max(1, Math.round(30 / interval)) === 0) log(`${Math.round((now() - start) / 1000)} s: ${probe.processes.map(p => `${p.role} ${(p.memory / MIB).toFixed(1)} MiB`).join(', ') || 'no process sample'}`)
      // The first probe is the warm-up; what the squeeze leaves after it is the base.
      if (i === 0) await squeezeNow()
    }
    await squeezeNow()
  } catch (error) {
    result.error = error.message
  }
  result.report = analyzeMemory(result.probes, { footprints: result.footprints })
  return { result, dir: status.dir ?? null }
}

/** Where a memory result goes when no --out: memory-<timestamp>.json in the debug dir. */
export const memoryPath = (dir, date = new Date()) => benchPath(dir, date, 'memory')
