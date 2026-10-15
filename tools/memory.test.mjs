// Unit tests for memory.mjs: slope, drawdowns and the verdict over synthetic series, the
// analysis of probes and its text, the driver with a fake clock and page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeMemory,
  categoriesText,
  categoryReport,
  drawdowns,
  FOOTPRINT,
  footprintOf,
  footprintText,
  judge,
  maxDrawdown,
  memoryPath,
  memoryText,
  PROBE,
  runMemory,
  SQUEEZE,
  squeezeOf,
  squeezeText,
  squeezeVerdict,
  slope,
} from './memory.mjs'

const MIB = 1048576
/** `n` points 5 s apart, value f(i) MiB. */
const series = (n, f) => Array.from({ length: n }, (_, i) => [i * 5000, f(i) * MIB])

test('slope: least squares in MiB per minute', () => {
  assert.equal(slope(series(25, i => 100 + i)), 12) // 1 MiB per 5 s
  assert.equal(slope(series(25, () => 100)), 0)
  assert.equal(slope([[0, MIB]]), null)
  assert.equal(
    slope([
      [0, MIB],
      [0, 2 * MIB],
    ]),
    null,
  ) // no time
})

test('max drawdown: the largest drop after a peak, as a share of the peak', () => {
  assert.equal(maxDrawdown([100, 120, 90, 130, 117]), 0.25)
  assert.equal(maxDrawdown([1, 2, 3]), 0)
  assert.equal(maxDrawdown([]), 0)
})

test('drawdowns: falls of 5 % or more from a local high, each ended by a climb back', () => {
  // A sawtooth: 100 → 120 in steps, a collection back to 100, three times.
  const saw = []
  for (let k = 0; k < 3; k++) for (let i = 0; i <= 4; i++) saw.push(100 + i * 5)
  assert.equal(drawdowns(saw).length, 2) // two falls 120 → 100 (the series ends at 120)
  assert.deepEqual(
    drawdowns([...saw, 100]).map(d => Math.round(d.depth * 1000) / 1000),
    [0.167, 0.167, 0.167],
  )
  assert.deepEqual(
    drawdowns([...saw, 100]).map(d => d.low),
    [5, 10, 15],
  ) // where each low is
  assert.deepEqual(drawdowns([100, 98, 101, 99, 102]), []) // under 5 %
  assert.equal(drawdowns([100, 90, 89, 88]).length, 1) // still falling at the end
})

test('verdicts: sawtooth, linear growth, plateau, growth with collections, flat, too short', () => {
  // GC sawtooth around a constant level: 100…120 MiB, collected every 25 s.
  const saw = judge(series(25, i => 100 + (i % 5) * 5))
  assert.equal(saw.verdict, 'gc-sawtooth')
  assert.ok(saw.drawdowns >= 2)
  assert.ok(saw.slope > 0.5) // least squares of a window ending on a peak: misleading on its own
  assert.equal(saw.floorSlope, 0) // the level after each collection does not move
  // Linear growth, nothing given back: 1 MiB every 5 s.
  const leak = judge(series(24, i => 100 + i))
  assert.equal(leak.verdict, 'growing')
  assert.equal(leak.slope, 12)
  assert.equal(leak.drawdowns, 0)
  assert.equal(leak.first, 100 * MIB)
  assert.equal(leak.last, 123 * MIB)
  // Grows for the first third, one collection, then level.
  const plateau = judge(series(24, i => (i < 8 ? 100 + i * 5 : i === 10 ? 130 : 140)))
  assert.equal(plateau.verdict, 'plateau')
  assert.ok(plateau.thirds.first > 0)
  assert.ok(plateau.thirds.last < plateau.thirds.first * 0.1)
  assert.ok(plateau.maxDrawdown >= 5)
  // Collections run but the floor rises: 100 + i, minus 10 % every fifth probe.
  const creep = judge(series(30, i => (100 + i * 2) * (i % 5 === 4 ? 0.9 : 1)))
  assert.equal(creep.verdict, 'growing-sawtooth')
  assert.ok(creep.floorSlope >= 0.5)
  assert.equal(judge(series(24, i => 100 + (i % 2) * 0.1)).verdict, 'flat')
  assert.equal(judge(series(5, i => 100 + i)).verdict, 'too-short')
})

const probe = (
  at,
  { web = 100, app = 50, listeners = { layout: 10, editor: 3 }, domNodes = 1000, windows = 2, reactRoots = 3 } = {},
) => ({
  at,
  t: at,
  processes: [
    { role: 'WebContent', scope: 'page', pid: 7, memory: web * MIB, cpu: 1 },
    { role: 'Tilr', scope: 'app', pid: 1, memory: app * MIB, cpu: 0.5 },
  ],
  windows,
  domNodes,
  listeners: { total: Object.values(listeners).reduce((a, b) => a + b, 0), byPlugin: listeners },
  reactRoots,
  canvases: 1,
  images: 0,
})

test('analysis: per process, counts first / last / Δ, the plugins whose listeners grew, hints', () => {
  const probes = Array.from({ length: 24 }, (_, i) =>
    probe(i * 5000, {
      web: 100 + i,
      listeners: { layout: 10, editor: 3 + i, files: i > 10 ? 2 : 1 },
      domNodes: 1000 + i * 40,
    }),
  )
  const r = analyzeMemory(probes)
  assert.deepEqual(
    r.processes.map(p => [p.role, p.pid, p.verdict, p.samples]),
    [
      ['WebContent', 7, 'growing', 24],
      ['Tilr', 1, 'flat', 24],
    ],
  )
  assert.deepEqual(r.counts.listeners, { first: 14, last: 38, delta: 24 })
  assert.deepEqual(r.counts.windows, { first: 2, last: 2, delta: 0 })
  assert.deepEqual(r.listeners, [
    { plugin: 'editor', first: 3, last: 26, delta: 23 },
    { plugin: 'files', first: 1, last: 2, delta: 1 },
  ])
  assert.match(r.hints[0], /^listeners grew \(14 → 38\): editor \+23, files \+1/)
  assert.match(r.hints[1], /^DOM leak: 920 more DOM nodes/)
  assert.ok(!r.hints.some(h => h.includes('JavaScript Allocations'))) // not with listeners and DOM growing too
  const text = memoryText({ seconds: 120, interval: 5, probes, report: r })
  assert.match(text, /^24 probes, every 5 s over 120 s/)
  assert.match(text, /WebContent \/ page +7 +100\.0 +123\.0 +100\.0 +123\.0 +12 +— +0 +0 +growing/)
  assert.match(text, /^listeners +14 +38 +\+24$/m)
  assert.match(text, /^WebContent 7: growing: grows and never gives memory back: a leak candidate$/m)
  assert.match(text, /^hint: listeners grew/m)
})

test('analysis: WebContent growing alone points at the JS heap; a pane process at scrollback', () => {
  const probes = Array.from({ length: 24 }, (_, i) => ({
    ...probe(i * 5000, { web: 100 + i }),
    processes: [
      { role: 'WebContent', scope: 'page', pid: 7, memory: (100 + i) * MIB, cpu: 1 },
      { role: 'pane', scope: 'server', pid: 9, memory: (10 + i) * MIB, cpu: 0 },
    ],
  }))
  const { hints } = analyzeMemory(probes)
  assert.equal(hints.length, 2)
  assert.match(hints[0], /JS heap.*Safari Web Inspector → Timelines → JavaScript Allocations.*`footprint 7`/)
  assert.match(hints[1], /^pane 9 grows .*scrollback, normal up to the server's scrollback limit/)
  assert.deepEqual(analyzeMemory([]).processes, [])
  assert.match(
    memoryText({ seconds: 10, interval: 5, probes: [], report: analyzeMemory([]), error: 'boom' }),
    /no process samples[\s\S]*error: boom \(a partial result\)$/,
  )
  assert.match(
    memoryPath('/tmp/d', new Date('2026-10-12T08:09:10.123Z')),
    /^\/tmp\/d\/memory-2026-10-12T08-09-10Z\.json$/,
  )
})

/** A footprint process (MiB). */
const fp = (pid, role, { malloc = 0, graphics = 0, js = 0, jit = 0, other = 0 } = {}) => ({
  pid,
  role,
  scope: 'page',
  reclaimable: 0,
  footprint: (malloc + graphics + js + jit + other) * MIB,
  categories: { malloc: malloc * MIB, graphics: graphics * MIB, js: js * MIB, jit: jit * MIB, other: other * MIB },
})
/** 24 regular probes of WebContent memory `f(i)` MiB, plus probes marked 'squeeze' after the first
 *  (at 2 s) and after the last (at 117 s) with `after` [first, last] MiB. */
const squeezed = (f, [first, last]) => {
  const probes = Array.from({ length: 24 }, (_, i) => probe(i * 5000, { web: f(i) }))
  probes.splice(1, 0, { ...probe(2000, { web: first }), phase: 'squeeze' })
  probes.push({ ...probe(117_000, { web: last }), phase: 'squeeze' })
  return probes
}

test('squeeze verdict: retained over max(10 MiB, 5 %) is a leak suspect; given back is cache-only; else the trend', () => {
  const at = (peak, first, last) => ({
    peak: peak * MIB,
    afterSqueeze: { first: first * MIB, last: last * MIB },
    retained: (last - first) * MIB,
  })
  assert.equal(squeezeVerdict(at(300, 100, 111), 'flat'), 'leak-suspect') // +11 MiB ≥ 10
  assert.equal(squeezeVerdict(at(300, 100, 109), 'growing'), 'cache-only') // under 10 MiB, peak 191 above
  assert.equal(squeezeVerdict(at(1000, 400, 420), 'flat'), 'leak-suspect') // 20 MiB ≥ 5 % of 400
  assert.equal(squeezeVerdict(at(1000, 400, 415), 'flat'), 'cache-only') // 15 < 20
  assert.equal(squeezeVerdict(at(105, 100, 101), 'gc-sawtooth'), 'gc-sawtooth') // nothing much either way
  assert.equal(squeezeVerdict({ peak: MIB, afterSqueeze: null, retained: null }, 'growing'), 'growing') // no squeezes
})

test('analysis with squeezes: peak, after squeeze, retained and its slope; squeeze probes stay out of the trend', () => {
  // Grows 100 → 215 MiB (a "leak" by the trend), but each squeeze leaves 100 → 104: cache-only.
  const cache = analyzeMemory(squeezed(i => 100 + i * 5, [100, 104])).processes.find(p => p.role === 'WebContent')
  assert.equal(cache.samples, 24) // the regular probes only
  assert.equal(cache.trend, 'growing')
  assert.equal(cache.verdict, 'cache-only')
  assert.equal(cache.peak, 215 * MIB)
  assert.deepEqual(cache.afterSqueeze, { first: 100 * MIB, last: 104 * MIB })
  assert.equal(cache.retained, 4 * MIB)
  assert.equal(cache.retainedSlope, 2.09) // 4 MiB over 115 s
  assert.equal(cache.reclaimed, 111 * MIB)
  // Flat to the trend, but what the squeezes leave grows by 30 MiB: a leak suspect, with the JS heap hint.
  const r = analyzeMemory(squeezed(() => 150, [100, 130]))
  const leak = r.processes.find(p => p.role === 'WebContent')
  assert.equal(leak.trend, 'flat')
  assert.equal(leak.verdict, 'leak-suspect')
  assert.match(r.hints.join('\n'), /WebContent 7 grows.*JS heap/)
  // Without squeezes the fields are null and the verdict is the trend.
  const plain = analyzeMemory(Array.from({ length: 24 }, (_, i) => probe(i * 5000))).processes[0]
  assert.equal(plain.afterSqueeze, null)
  assert.equal(plain.retained, null)
  assert.equal(plain.verdict, plain.trend)
})

test('categories: peak vs after squeeze per process, Δ, the table and the graphics / malloc hints', () => {
  const footprints = [
    { at: 0, processes: [fp(7, 'webcontent', { malloc: 150, graphics: 200, js: 1, other: 20 })] },
    { at: 2000, phase: 'squeeze', processes: [fp(7, 'webcontent', { malloc: 90, graphics: 200, js: 1, other: 20 })] },
    {
      at: 60_000,
      processes: [
        fp(7, 'webcontent', { malloc: 209, graphics: 200, js: 1, other: 25 }),
        fp(1, 'tilr', { malloc: 60, other: 10 }),
      ],
    },
    {
      at: 117_000,
      phase: 'squeeze',
      processes: [fp(7, 'webcontent', { malloc: 93, graphics: 201, js: 1, other: 20 })],
    },
  ]
  const [web, app] = categoryReport(footprints)
  assert.equal(web.peak.at, 60_000) // the largest outside the squeezes
  assert.equal(web.afterSqueeze.at, 117_000) // the last squeeze
  assert.equal(web.delta.malloc, -116 * MIB)
  assert.equal(web.delta.graphics, MIB)
  assert.equal(web.delta.footprint, -120 * MIB)
  assert.equal(web.dominant, 'malloc')
  assert.equal(app.afterSqueeze, null)
  assert.equal(app.delta, null)
  const text = categoriesText([web, app])
  assert.match(text, /^footprint MiB +pid +when +total +malloc +graphics +js +jit +other$/m)
  assert.match(text, /^webcontent \/ page +7 +peak +435\.0 +209\.0 +200\.0 +1\.0 +0\.0 +25\.0$/m)
  assert.match(text, /^ +after squeeze +315\.0 +93\.0 +201\.0 +1\.0 +0\.0 +20\.0$/m)
  assert.match(text, /^ +Δ +-120\.0 +-116\.0 +\+1\.0 +0\.0 +0\.0 +-5\.0$/m)
  assert.match(text, /^tilr \/ page +1 +peak +70\.0/m)
  const { hints, categories } = analyzeMemory([], { footprints })
  assert.equal(categories.length, 2)
  assert.match(
    hints.join('\n'),
    /webcontent 7: malloc 209\.0 → 93\.0 MiB after the squeeze: uncollected garbage, not a leak/,
  )
  // Graphics the largest part: the compositing hint, the squeeze did not free it.
  const tiles = analyzeMemory([], {
    footprints: [
      { at: 0, processes: [fp(7, 'webcontent', { malloc: 100, graphics: 200 })] },
      { at: 9000, phase: 'squeeze', processes: [fp(7, 'webcontent', { malloc: 90, graphics: 200 })] },
    ],
  })
  assert.match(
    tiles.hints[0],
    /^webcontent 7: graphics is the largest part, 200\.0 of 300\.0 MiB; after the squeeze 200\.0 MiB \(\+0\.0\): a squeeze does not free it: compositing layers\/tiles: open Safari Web Inspector → Layers; `tilr ctl debug inspect`/,
  )
  assert.equal(tiles.hints.length, 1) // malloc 100 → 90 is not much
})

test("replies by their shape: undefined or an older app's answer is n/a", () => {
  assert.equal(footprintOf(undefined), null)
  assert.equal(footprintOf(null), null)
  assert.equal(footprintOf([{ name: 'WebContent' }]), null) // a sample's answer
  assert.equal(footprintOf('Unknown performance request.'), null)
  assert.deepEqual(
    footprintOf({ processes: [fp(7, 'webcontent', { malloc: 1 }), { pid: 2 }], took: 120 }).processes.map(p => p.pid),
    [7],
  )
  assert.equal(squeezeOf(undefined), null)
  assert.equal(squeezeOf({ shown: true }), null)
  assert.deepEqual(squeezeOf({ before: 2, after: 1 }), { method: '', before: 2, after: 1 })
  assert.equal(footprintText(null), 'footprint: n/a (update the Mac app)')
  assert.equal(squeezeText(null), 'squeeze: n/a (update the Mac app)')
  assert.match(
    squeezeText({ method: 'memory-pressure', before: 435 * MIB, after: 319 * MIB }),
    /^squeeze \(memory-pressure\): WebContent 435\.0 → 319\.0 MiB \(-116\.0\)\n\(a squeeze may be system-wide/,
  )
  assert.match(
    footprintText({ processes: [fp(7, 'webcontent', { malloc: 209, graphics: 200 })], took: 140 }),
    /^webcontent \/ page +7 +409\.0 +209\.0 +200\.0 +0\.0 +0\.0 +0\.0 +0\.0\ntook 140 ms$/m,
  )
})

/** A page for runMemory(): a fake clock, WebContent memory from `memory(t)`, footprint and squeeze
 *  answers from `native` (undefined: an older app). */
function fakePage({ memory = () => 100, footprint, squeeze } = {}) {
  let t = 0
  const calls = []
  return {
    calls,
    now: () => t,
    wait: async ms => {
      t += ms
    },
    page: {
      debug: async () => ({ enabled: true, dir: '/tmp/d' }),
      evaluate: async js => {
        if (js === PROBE) {
          calls.push('probe')
          return { t, ...probe(t, { web: memory(t) }) }
        }
        if (js === FOOTPRINT) {
          calls.push('footprint')
          return footprint?.(t)
        }
        if (js === SQUEEZE) {
          calls.push('squeeze')
          return squeeze?.(t)
        }
        throw new Error(`unexpected eval ${js}`)
      },
    },
  }
}

test('runMemory: an older app (undefined replies) gives the probes alone, n/a for categories and squeeze', async () => {
  const fake = fakePage()
  const logs = []
  const { result } = await runMemory({
    seconds: 30,
    interval: 5,
    now: fake.now,
    wait: fake.wait,
    page: fake.page,
    log: l => logs.push(l),
  })
  assert.equal(result.probes.length, 7)
  assert.deepEqual(result.support, { footprint: false, squeeze: false })
  assert.deepEqual(result.footprints, [])
  assert.deepEqual(result.squeezes, [])
  assert.equal(fake.calls.filter(c => c === 'footprint').length, 1) // asked once, then not again
  assert.equal(fake.calls.filter(c => c === 'squeeze').length, 1)
  assert.ok(logs.includes('squeeze: n/a (update the Mac app)'))
  const text = memoryText(result)
  assert.match(text, /^squeeze: n\/a \(update the Mac app\)$/m)
  assert.match(text, /^categories: n\/a \(update the Mac app\)$/m)
  assert.equal(result.error, undefined)
  // --no-squeeze: never asked.
  const off = fakePage()
  const { result: r2 } = await runMemory({
    seconds: 10,
    interval: 5,
    squeeze: false,
    now: off.now,
    wait: off.wait,
    page: off.page,
  })
  assert.ok(!off.calls.includes('squeeze'))
  assert.match(memoryText(r2), /^squeeze: off \(--no-squeeze\)$/m)
})

test('runMemory: squeezes after the warm-up and at the end, footprints at every probe, a verdict from what stays', async () => {
  // Memory grows 2 MiB per 5 s; a squeeze gives back all but 100 + t/10 s MiB (40 MiB retained over the run).
  const fake = fakePage({
    memory: t => 100 + t / 2500,
    footprint: t => ({ took: 150, processes: [fp(7, 'webcontent', { malloc: 50 + t / 2500, graphics: 50 })] }),
    squeeze: t => ({ method: 'memory-pressure', before: (100 + t / 2500) * MIB, after: 90 * MIB }),
  })
  const { result } = await runMemory({ seconds: 60, interval: 5, now: fake.now, wait: fake.wait, page: fake.page })
  assert.equal(result.squeezes.length, 2)
  assert.deepEqual(
    result.squeezes.map(s => s.at),
    [0, 60_000],
  )
  const after = result.probes.filter(p => p.phase === 'squeeze')
  assert.deepEqual(
    after.map(p => p.at),
    [3000, 63_000],
  ) // 3 s after each squeeze
  assert.equal(result.probes.length, 13 + 2)
  assert.equal(result.footprints.length, 15)
  assert.deepEqual(
    result.footprints.filter(f => f.phase === 'squeeze').map(f => f.at),
    [3000, 63_000],
  )
  assert.deepEqual(result.support, { footprint: true, squeeze: true })
  const web = result.report.processes.find(p => p.role === 'WebContent')
  assert.equal(web.retained, (101.2 + 24) * MIB - 101.2 * MIB)
  assert.equal(web.verdict, 'leak-suspect')
  assert.equal(result.report.categories[0].afterSqueeze.at, 63_000)
  const text = memoryText(result)
  assert.match(text, /^13 probes, every 5 s over 60 s$/m)
  assert.match(text, /^squeeze 1 at 0 s \(memory-pressure\): WebContent 100\.0 → 90\.0 MiB$/m)
  assert.match(text, /^after squeeze +pid +peak MiB +first +last +retained +retained MiB\/min +reclaimed +trend$/m)
  assert.match(text, /^WebContent \/ page +7 +125\.2 +101\.2 +125\.2 +\+24\.0 +24 +0\.0 +growing$/m)
  assert.match(text, /^WebContent 7: leak-suspect: /m)
  assert.match(text, /^footprint MiB +pid +when/m)
})
