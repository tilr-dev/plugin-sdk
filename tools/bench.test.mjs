// Unit tests for bench.mjs: the numbers a scenario takes from its recording (metrics series as the
// collector emits them, samples), and the comparison of two results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { benchPath, benchText, COMPARE_KEYS, compareBench, compareText, coverageOf, extractIdle, extractThroughput, extractTyping, HOPS, METRIC_RING, promptLine, seriesKey, totals } from './bench.mjs'

const PANE = 'p-bench'
const OTHER = 'p-other'

/** A series as `snapshot()` / `finish()` emit it: session totals, `recent` and `seconds` in the window. */
function metric(name, labels, recent, { before = { count: 0, sum: 0 }, seconds } = {}) {
  const values = recent.map(([, v]) => v)
  const sum = values.reduce((a, b) => a + b, 0)
  const buckets = new Map()
  for (const [t, v] of recent) {
    const s = Math.floor(t / 1000)
    const b = buckets.get(s) ?? [s, 0, 0]
    b[1]++; b[2] += v
    buckets.set(s, b)
  }
  return {
    name, labels: Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))),
    count: before.count + values.length, sum: before.sum + sum,
    min: Math.min(...values), max: Math.max(...values), last: values.at(-1), t: recent.at(-1)[0],
    recent, seconds: seconds ?? [...buckets.values()],
  }
}
const proc = (name, cpu, memory, pid = name === 'Tilr' ? 1 : 2) => ({ pid, name, scope: name === 'Tilr' ? 'app' : 'page', cpu, cpuSeconds: 0, memory })
const sample = (t, { fps = null, commits = 0, web = 10, app = 2, memory = 100 * 1048576, visible = true } = {}) =>
  ({ t, visible, fps, frameP95: null, frameMax: null, commits, renderMs: 0, processes: [proc('Tilr', app, 50 * 1048576), proc('WebContent', web, memory)] })
const recording = (started, ended, samples, metrics) => ({ version: 1, origin: 0, react: 'dev', started, ended, samples, events: [], dropped: {}, metrics })

/** 1000 observations over 10…12 s, for each hop: value i % 10 + 1 (ms), so p50 5, p95 10. */
const hop = (name, hopName, pane = PANE) => metric(name, { chain: 'terminal', hop: hopName, pane }, Array.from({ length: 20 }, (_, i) => [10_000 + i * 100, (i % 10) + 1]))

test('throughput: frames and bytes from the totals since record(), hops of the bench pane only, CPU and FPS from the samples', () => {
  const frames0 = metric('server.frame_bytes', { pane: PANE, zstd: '0' }, [[10_100, 100], [10_200, 300]], { before: { count: 5, sum: 1000 } })
  const frames1 = metric('server.frame_bytes', { pane: PANE, zstd: '1' }, [[10_300, 50]])
  const other = metric('server.frame_bytes', { pane: OTHER, zstd: '1' }, [[10_300, 99_999]])
  const before = { [seriesKey(frames0)]: { count: 5, sum: 1000 } }
  const hops = Object.entries(HOPS).map(([h, name], i) => hop(name, `${(i + 2) * 10}-${h}`))
  const rec = recording(10_000, 12_500, [sample(9_900, { web: 99 }), sample(11_000, { fps: 60, web: 40 }), sample(12_000, { fps: 30, web: 80, app: 4 })], [
    frames0, frames1, other, ...hops,
    hop('server.decode', '70-decode', OTHER),
    metric('server.rows_changed', { pane: PANE }, [[10_100, 24], [10_200, 24], [10_300, 10]]),
    metric('server.output_bytes', { pane: PANE }, [[10_100, 4096], [10_200, 2048]]),
    metric('terminal.frames_per_paint', { pane: PANE }, [[10_150, 1], [10_250, 3], [10_350, 2]]),
  ])
  const t = extractThroughput(rec, { pane: PANE, before, wallMs: 1234.567, size: 200_000 })
  assert.equal(t.wallMs, 1234.6)
  assert.equal(t.frames, 3) // 2 + 1 in the window, not the 5 before it nor the other pane's
  assert.equal(t.bytes, 450)
  assert.equal(t.rowsChanged, 58)
  assert.equal(t.outputBytes, 6144)
  assert.deepEqual(t.hops.decode, { p50: 5, p95: 10, n: 20, coverage: 'full' }) // the other pane's decode left out
  assert.deepEqual(Object.keys(t.hops), Object.keys(HOPS))
  assert.equal(t.framesPerPaint.p50, 2)
  assert.equal(t.draws, 20)
  assert.equal(t.drawMs, 110) // terminal.draw: 2 × (1 + … + 10)
  assert.deepEqual(t.fps, { p50: 30, max: 60, n: 2 })
  assert.deepEqual(t.cpu.webContent, { mean: 60, max: 80 }) // the sample before the window left out
  assert.equal(t.cpu.tilr.mean, 3)
  assert.equal(t.durationMs, 2500)
  assert.equal(t.timedOut, false)
})

test('totals without the counts before record(): the per-second buckets overlapping the window', () => {
  const m = metric('server.frame_bytes', { pane: PANE }, [[9_500, 1], [10_100, 2], [11_900, 3], [13_100, 4]])
  const rec = recording(10_000, 12_000, [], [m])
  assert.deepEqual(totals(rec, [m]), { count: 2, sum: 5 })
  assert.deepEqual(totals(rec, [m], { [seriesKey(m)]: { count: 1, sum: 1 } }), { count: 3, sum: 9 })
})

test('typing: key → frame / paint, echo, rtt of the bench server, server input, echo lost', () => {
  const keys = Array.from({ length: 61 }, (_, i) => [20_000 + i * 50, 4 + (i % 4)])
  const rec = recording(20_000, 23_600, [sample(21_000), sample(22_000)], [
    metric('terminal.key_to_frame', { chain: 'terminal', end: '1', pane: PANE }, keys),
    metric('terminal.key_to_paint', { chain: 'terminal', end: '1', pane: PANE }, keys.map(([t, v]) => [t + 8, v + 8])),
    metric('terminal.key_to_paint', { chain: 'terminal', end: '1', pane: OTHER }, [[20_100, 500]]),
    metric('terminal.echo', { chain: 'terminal', end: '1', pane: PANE }, keys.map(([t, v]) => [t, v - 1])),
    metric('server.rtt', { server: 'local' }, [[20_500, 1.25], [21_500, 1.5], [22_500, 2]]),
    metric('server.rtt', { server: 'remote' }, [[20_500, 80]]),
    metric('server.input', { chain: 'terminal', hop: '10-input', pane: PANE }, [[20_010, 0.1], [20_060, 0.2]]),
    metric('terminal.echo_lost', { pane: PANE }, [[23_000, 1]]),
  ])
  const k = extractTyping(rec, { pane: PANE, server: 'local', before: {}, method: 'keydown' })
  assert.equal(k.keys, 60)
  assert.equal(k.method, 'keydown')
  assert.deepEqual(k.keyToFrame, { p50: 5, p95: 7, max: 7, n: 61, coverage: 'full' })
  assert.deepEqual(k.keyToPaint, { p50: 13, p95: 15, max: 15, n: 61, coverage: 'full' }) // the other pane's 500 left out
  assert.equal(k.echo.p95, 6)
  assert.deepEqual(k.rtt, { p50: 1.5, p95: 2, max: 2, n: 3, coverage: 'full' }) // not the remote profile's
  assert.equal(k.input.max, 0.2)
  assert.equal(k.echoLost, 1)
})

test('idle: CPU and memory, React commits/s, FPS, inputs, frames and draws of the bench pane', () => {
  const rec = recording(30_000, 40_000, [
    { ...sample(31_000, { web: null }), processes: [proc('Tilr', 1, 50e6), proc('WebContent', null, 200e6)] },
    sample(32_000, { web: 2, app: 0.5, commits: 3, memory: 201e6 }),
    sample(33_000, { web: 4, app: 1.5, commits: 1, memory: 199e6 }),
    { ...sample(34_000), processes: [proc('Tilr', 1, 50e6), proc('WebContent', 3, 100e6, 2), proc('WebContent', 3, 110e6, 3)] },
  ], [
    metric('server.frame_bytes', { pane: OTHER, zstd: '1' }, [[35_000, 100]]),
    metric('terminal.draw', { chain: 'terminal', hop: '90-draw', pane: OTHER }, [[35_000, 1]]),
    metric('input.delay', { type: 'keydown' }, [[29_000, 20]], { before: { count: 0, sum: 0 } }),
  ])
  const before = { [seriesKey(rec.metrics[2])]: { count: 1, sum: 20 } }
  const i = extractIdle(rec, { pane: PANE, before, seconds: 10 })
  assert.deepEqual(i.cpu.webContent, { mean: 4, max: 6 }) // the first sample (no CPU yet) left out; two processes summed
  assert.deepEqual(i.cpu.tilr, { mean: 1, max: 1.5 })
  assert.deepEqual(i.memory.webContent, { last: 210e6, max: 210e6 })
  assert.equal(i.reactCommitsPerSecond, 1)
  assert.deepEqual(i.fps, { p50: null, max: null, n: 0 }) // no frame loop: n/a, not 0
  assert.equal(i.visible, true)
  assert.equal(i.inputs, 0)
  assert.equal(i.frames, 0) // the other pane's frame is not the bench terminal's
  assert.equal(i.drawMs, 0)
  assert.equal(i.samples, 4)
})

const result = (scenarios) => ({ version: 1, when: '2026-10-12T00:00:00.000Z', env: { tilr: '0.1.12', react: 'profiling' }, scenarios })
const A = result({
  throughput: { wallMs: 1000, bytes: 5_000_000, frames: 400, hops: { wait: { p50: 1, p95: 2 }, decode: { p50: 0.5, p95: 1 } }, drawMs: 300 },
  typing: { keyToPaint: { p50: 10, p95: 20 }, echo: { p95: 8 }, rtt: { p50: 1 } },
  idle: { cpu: { webContent: { mean: 0 }, tilr: { mean: 1 } }, memory: { webContent: { max: 200_000_000 } } },
})
const B = result({
  throughput: { wallMs: 1050, bytes: 5_000_000, frames: 380, hops: { wait: { p50: 1, p95: 2.5 }, decode: { p50: 0.5, p95: 1 } }, drawMs: 240 },
  typing: { keyToPaint: { p50: 10, p95: 30 }, echo: { p95: 8.4 }, rtt: { p50: 1 } },
  idle: { cpu: { webContent: { mean: 3 }, tilr: { mean: 1 } }, memory: { webContent: { max: 210_000_000 } } },
})

test('compare: Δ% per key, regressions beyond the threshold marked; from 0 above the floor and missing in B are regressions', () => {
  const c = compareBench(A, B, { threshold: 10 })
  const row = key => c.rows.find(r => r.key === key)
  assert.deepEqual(row('throughput.wallMs'), { key: 'throughput.wallMs', label: 'throughput wall ms', a: 1000, b: 1050, delta: 5, regressed: false })
  assert.equal(row('throughput.frames').delta, -5)
  assert.equal(row('throughput.hops.wait.p95').regressed, true) // +25 %
  assert.equal(row('throughput.drawMs').delta, -20)
  assert.equal(row('typing.keyToPaint.p95').regressed, true) // +50 %
  assert.equal(row('typing.echo.p95').regressed, false) // +5 %
  assert.deepEqual(row('idle.cpu.webContent.mean'), { key: 'idle.cpu.webContent.mean', label: 'idle WebContent CPU mean %', a: 0, b: 3, delta: null, regressed: true, fromZero: true }) // 0 → 3 %: above the 1 % floor
  assert.equal(row('idle.memory.webContent.max').delta, 5)
  assert.equal(row('throughput.hops.parse.p95'), undefined) // in neither
  assert.equal(c.regressed, true)
  assert.deepEqual(c.rows.filter(r => r.regressed).map(r => r.key), ['throughput.hops.wait.p95', 'typing.keyToPaint.p95', 'idle.cpu.webContent.mean'])
  assert.deepEqual(c.warnings, [])
  assert.equal(compareBench(A, A).regressed, false)
  const text = compareText(c)
  assert.match(text, /^metric\s+A\s+B\s+Δ%$/m)
  assert.match(text, /typing key_to_paint p95 ms\s+20\s+30\s+\+50\.0% !$/m)
  assert.match(text, /idle WebContent CPU mean %\s+0\s+3\s+from 0 !$/m)
  assert.match(text, /3 regressions beyond 10%$/)
})

test('compare: zero baselines against the floor of their unit, a number missing in B, a key only in B', () => {
  const zero = result({ idle: { cpu: { webContent: { mean: 0 }, tilr: { mean: 0 } }, memory: { webContent: { max: 0 } } }, throughput: { drawMs: 0, frames: 0 } })
  const small = result({ idle: { cpu: { webContent: { mean: 0.9 }, tilr: { mean: 1 } }, memory: { webContent: { max: 1048576 } } }, throughput: { drawMs: 1, frames: 1 } })
  const c = compareBench(zero, small)
  assert.equal(c.regressed, false) // at the floors (1 %, 1 MiB, 1 ms, 1), not above
  assert.ok(c.rows.every(r => r.fromZero && r.delta === null))
  const big = result({ idle: { cpu: { webContent: { mean: 0 }, tilr: { mean: 0 } }, memory: { webContent: { max: 1048577 } } }, throughput: { drawMs: 1.5, frames: 2 } })
  assert.deepEqual(compareBench(zero, big).rows.filter(r => r.regressed).map(r => r.key), ['throughput.frames', 'throughput.drawMs', 'idle.memory.webContent.max'])
  // A number in A that B lacks: a regression shown as missing; a key only in B does not count.
  const lost = compareBench(result({ typing: { keyToPaint: { p50: 10, p95: 20 } } }), result({ typing: { keyToPaint: { p50: 10, p95: null }, echo: { p95: 8 } } }))
  const missing = lost.rows.find(r => r.key === 'typing.keyToPaint.p95')
  assert.deepEqual(missing, { key: 'typing.keyToPaint.p95', label: 'typing key_to_paint p95 ms', a: 20, b: null, delta: null, regressed: true, missing: true })
  assert.equal(lost.rows.find(r => r.key === 'typing.echo.p95').regressed, false)
  assert.equal(lost.regressed, true)
  assert.match(compareText(lost), /typing key_to_paint p95 ms\s+20\s+—\s+missing !$/m)
  // A whole scenario B did not run: each of A's numbers is missing.
  const half = compareBench(result({ idle: A.scenarios.idle }), result({ typing: B.scenarios.typing }))
  assert.ok(half.rows.filter(r => r.a !== null).every(r => r.missing && r.regressed))
  assert.ok(half.rows.filter(r => r.a === null).every(r => !r.regressed))
  assert.ok(COMPARE_KEYS.length >= 18)
})

test('compare: warns when the runs differ (size, seconds, method, React build, versions)', () => {
  const a = { ...result({ throughput: { size: 200_000, wallMs: 1 }, idle: { seconds: 10 }, typing: { method: 'keydown' } }), env: { react: 'profiling', plugins: { server: '0.9.0', terminal: '0.8.3', performance: '0.1.12' }, serverVersion: '1.0.0' } }
  const b = { ...result({ throughput: { size: 100_000, wallMs: 1 }, idle: { seconds: 10 }, typing: { method: 'paste' } }), env: { react: 'dev', plugins: { server: '0.9.1', terminal: '0.8.3', performance: '0.1.12' }, serverVersion: '1.0.0' } }
  const c = compareBench(a, b)
  assert.deepEqual(c.warnings, ['throughput size differs: 200000 vs 100000', 'typing method differs: keydown vs paste', 'React build differs: profiling vs dev', 'server plugin differs: 0.9.0 vs 0.9.1'])
  const text = compareText(c).split('\n')
  assert.equal(text[0], 'warning: throughput size differs: 200000 vs 100000')
  assert.match(text[4], /^metric/)
  // A scenario on one side only: its parameters are not compared.
  assert.deepEqual(compareBench(result({ idle: { seconds: 10 } }), result({ typing: { method: 'paste' } })).warnings, [])
})

test('series keys: label order does not matter (Tilr Control reorders object keys)', () => {
  const m = { name: 'server.frame_bytes', labels: { pane: PANE, zstd: '1', chain: 'terminal' } }
  const shuffled = { name: 'server.frame_bytes', labels: { zstd: '1', chain: 'terminal', pane: PANE } }
  assert.equal(seriesKey(m), seriesKey(shuffled))
  assert.notEqual(seriesKey(m), seriesKey({ ...m, labels: { ...m.labels, zstd: '0' } }))
  // `before` computed in the page, the recording's labels in another order after the round trip.
  const series = metric('server.frame_bytes', { pane: PANE, zstd: '1' }, [[10_100, 100]], { before: { count: 5, sum: 500 } })
  const before = { [seriesKey(series)]: { count: 5, sum: 500 } }
  const reordered = { ...series, labels: { zstd: '1', pane: PANE } }
  assert.deepEqual(totals(recording(10_000, 11_000, [], [reordered]), [reordered], before), { count: 1, sum: 100 })
})

test('coverage: tail when the series had more observations in the window than its ring kept', () => {
  const ring = Array.from({ length: METRIC_RING }, (_, i) => [10_500 + i, 1])
  const m = { ...metric('server.decode', { pane: PANE }, ring), count: 1000 }
  const rec = recording(10_000, 12_000, [], [m])
  assert.equal(coverageOf(rec, [m], { [seriesKey(m)]: { count: 0, sum: 0 } }), 'tail') // 1000 since record(), 256 kept
  assert.equal(coverageOf(rec, [m], { [seriesKey(m)]: { count: 744, sum: 0 } }), 'full')
  assert.equal(coverageOf(rec, [m]), 'tail') // without totals: a full ring starting inside the window
  const t = extractThroughput(recording(10_000, 12_000, [], [{ ...m, name: 'server.decode', labels: { chain: 'terminal', hop: '70-decode', pane: PANE } }]), { pane: PANE, before: {}, wallMs: 1, size: 1 })
  assert.deepEqual(t.hops.decode, { p50: 1, p95: 1, n: 256, coverage: 'tail' })
  assert.match(benchText(result({ throughput: t })), /decode p50 \/ p95 ms\s+1 \/ 1 · n=256 \(tail\)/)
})

test('a shell prompt: the last line ends with $, %, >, # or ❯', () => {
  for (const line of ['dan@mac ~ %', 'bash-5.2$ ', '❯', 'root@box:/# ', 'PS C:\\> ', '~/src >']) assert.equal(promptLine(line), true, line)
  for (const line of ['', '~', 'vim', '-- INSERT --', '(END)']) assert.equal(promptLine(line), false, line)
})

test('the text table and the default path', () => {
  const text = benchText(result({ idle: { seconds: 10, cpu: { webContent: { mean: 1.2, max: 2 }, tilr: { mean: 0.3, max: 1 } }, memory: { webContent: { max: 209715200 }, tilr: { max: null } }, reactCommitsPerSecond: 0, fps: { p50: null }, visible: true, inputs: 0, frames: 0, drawMs: 0 } }))
  assert.match(text, /idle\s+CPU % mean \/ max \(10 s\)\s+WebContent 1\.2 \/ 2 · Tilr 0\.3 \/ 1/)
  assert.match(text, /WebContent 200\.0 MiB · Tilr —/)
  assert.equal(benchPath('/tmp/d', new Date('2026-10-12T08:09:10.123Z')), '/tmp/d/bench-2026-10-12T08-09-10Z.json')
  assert.match(benchPath(null, new Date(0)), /\/\.config\/tilr\/debug\/bench-1970-01-01T00-00-00Z\.json$/)
  assert.match(benchText({ ...result({}), error: 'bench: the terminal window w1 is gone' }), /error: bench: the terminal window w1 is gone \(a partial result/)
})
