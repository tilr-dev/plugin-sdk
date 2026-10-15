// Unit tests for control.mjs' window helpers: naming a window the way an agent knows it
// (resolveWindow) and the compact list tilr_windows answers (windowsText).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debugNative, debugText, metricRows, metricsText, resolveWindow, shown, windowsText } from './control.mjs'

const rect = (width, height) => ({ x: 0, y: 0, width, height })
const ROWS = [
  { id: 'w1', type: 'panel', title: 'plugins', mode: 'float', focused: false, parent: null, rect: rect(300, 400) },
  { id: 'w2', type: 'tabs', title: 'π dev', mode: 'tile', focused: false, parent: null, rect: rect(800, 600) },
  { id: 'w3', type: 'terminal', title: 'zsh', mode: 'nested', focused: true, parent: 'w2', rect: rect(800, 570) },
  { id: 'w4', type: 'terminal', title: 'π build', mode: 'nested', focused: false, parent: 'w2', rect: rect(0, 0) },
  { id: 'w5', type: 'clock', title: 'clock', mode: 'tile', focused: false, parent: null, rect: rect(400, 600) },
]

test('resolveWindow: an id, an exact title, a type, a part or a glob of a title', () => {
  const id = query => resolveWindow(query, ROWS).id
  assert.equal(id('w4'), 'w4')
  assert.equal(id('zsh'), 'w3')
  assert.equal(id('panel'), 'w1')
  assert.equal(id('PLUG'), 'w1')
  assert.equal(id('π d*'), 'w2')
  assert.equal(id('*BUILD'), 'w4')
  // An exact title before a type of the same name.
  assert.equal(id('clock'), 'w5')
})

test('resolveWindow: several matches or none are errors listing the windows', () => {
  assert.throws(() => resolveWindow('terminal', ROWS), {
    message: '"terminal" matches 2 windows; name one by id:\nw3 "zsh" (terminal)\nw4 "π build" (terminal)',
  })
  assert.throws(() => resolveWindow('π*', ROWS), /^Error: "π\*" matches 2 windows; name one by id:\nw2 "π dev" \(tabs\)\nw4 "π build" \(terminal\)$/)
  assert.throws(() => resolveWindow('vim', ROWS), /^Error: no window "vim"; the open ones:\nw1 "plugins" \(panel\)\nw2/)
  assert.throws(() => resolveWindow('x', []), { message: 'no window "x"; the open ones:\n(none)' })
  assert.throws(() => resolveWindow('', ROWS), /which window\?/)
})

test('windowsText: a line per window, tabs nobody sees left out unless all', () => {
  assert.equal(shown(ROWS[3], ROWS), false)
  assert.equal(shown(ROWS[2], ROWS), true)
  assert.equal(windowsText(ROWS), [
    'w1  panel  float  "plugins"',
    'w2  tabs  tile  "π dev"',
    'w3  terminal  nested  "zsh" [focused]',
    'w5  clock  tile  "clock"',
    '(+1 hidden tab: all: true lists them)',
  ].join('\n'))
  assert.equal(windowsText(ROWS, { all: true }).split('\n')[3], 'w4  terminal  nested  "π build"')
  // A window inside a hidden tab is hidden too.
  const inner = { id: 'w6', type: 'log', title: 'log', mode: 'nested', focused: false, parent: 'w4', rect: rect(10, 10) }
  assert.equal(shown(inner, [...ROWS, inner]), false)
  assert.equal(windowsText([]), 'no windows')
})

test('debug metrics: rows over the last 10 s, a name-prefix filter, an aligned table', () => {
  const metrics = [
    { name: 'terminal.draw', labels: { chain: 'terminal', hop: '50-draw' }, count: 40, sum: 80, min: 1, max: 9, last: 2, t: 19_500,
      recent: [[5000, 9], [12_000, 1], [15_000, 2], [19_500, 3]], seconds: [[5, 1, 9], [12, 1, 1], [15, 1, 2], [19, 1, 3]] },
    { name: 'plugin.start', labels: { plugin: 'files' }, count: 1, sum: 12, min: 12, max: 12, last: 12, t: 100, recent: [[100, 12]], seconds: [[0, 1, 12]] },
  ]
  const rows = metricRows({ ended: 20_000, metrics })
  assert.deepEqual(rows.map(r => r.name), ['plugin.start', 'terminal.draw'])
  assert.deepEqual(rows[1], { name: 'terminal.draw', labels: { chain: 'terminal', hop: '50-draw' }, count: 40, rate: 0.3, p50: 2, p95: 3, max: 3, n: 3, coverage: 'full', last: 2 })
  assert.equal(rows[0].p50, null) // nothing in the last 10 s
  assert.deepEqual(metricRows({ ended: 20_000, metrics }, { filter: 'terminal.' }).map(r => r.name), ['terminal.draw'])
  const text = metricsText(rows).split('\n')
  assert.match(text[0], /^name +labels +count +rate\/s +p50 +p95 +max +n +last$/)
  assert.match(text[2], /^terminal\.draw +chain=terminal,hop=50-draw +40 +0\.3 +2\.00 +3\.00 +3\.00 +3 +2\.00$/)
  assert.equal(metricsText([]), 'no metrics')
})

test('debug metrics: rate over whole seconds only, tail coverage, labels in key order whatever the JSON order', () => {
  // (10.5 s, 20.5 s]: seconds 11…19 are whole; 10 and 20 are partial and left out.
  const m = { name: 'x.y', labels: { pane: 'p', chain: 'c' }, count: 5, sum: 5, min: 1, max: 1, last: 1, t: 20_100,
    recent: [[10_600, 1], [11_000, 1], [15_000, 1], [19_999, 1], [20_100, 1]], seconds: [[10, 1, 1], [11, 1, 1], [15, 1, 1], [19, 1, 1], [20, 1, 1]] }
  const [row] = metricRows({ ended: 20_500, metrics: [m] })
  assert.equal(row.rate, 3 / 9)
  assert.equal(row.n, 5)
  const ring = Array.from({ length: 256 }, (_, i) => [15_000 + i, 1])
  const [tail] = metricRows({ ended: 20_000, metrics: [{ ...m, count: 1000, recent: ring }] })
  assert.equal(tail.coverage, 'tail')
  assert.match(metricsText([tail]), /256 \(tail\) +1\.00$/m)
  const shuffled = { ...m, labels: { chain: 'c', pane: 'p' } }
  assert.equal(metricsText(metricRows({ ended: 20_500, metrics: [m] })), metricsText(metricRows({ ended: 20_500, metrics: [shuffled] })))
  assert.match(metricsText([row]), /chain=c,pane=p/)
})

test('debugText: on / off answers as a sentence, a status as lines', () => {
  assert.equal(debugText({ mechanism: 'performance', requested: true, reloading: true }), 'collection on: switching, the page reloads (performance)')
  assert.equal(debugText({ mechanism: 'performance', requested: false, reloading: false }), 'collection off: already off, no reload (performance)')
  assert.equal(debugText({ enabled: true, react: 'dev', dir: '/tmp/d' }), 'enabled: true\nreact: dev\ndir: /tmp/d')
})

test('debugNative: the app\'s own debug action, else the page\'s eval; other failures are errors', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tilr-control-'))
  const socket = join(dir, 's')
  let native = request => ({ ok: true, shown: true, via: request.action })
  const seen = []
  const server = createServer(connection => connection.on('data', chunk => {
    const request = JSON.parse(String(chunk))
    seen.push(request.cmd)
    const reply = request.cmd === 'eval' ? { ok: true, value: { shown: false, via: 'eval' } } : native(request)
    connection.end(JSON.stringify({ id: request.id, ...reply }) + '\n')
  }))
  await new Promise(resolve => server.listen(socket, resolve))
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.deepEqual(await debugNative('inspect', 'return 1', { socket }), { shown: true, via: 'inspect' })
  native = () => ({ ok: false, error: 'performance: expected status, on, off or record' }) // an older app
  assert.deepEqual(await debugNative('inspect', 'return 1', { socket }), { shown: false, via: 'eval' })
  native = () => ({ ok: false, error: 'footprint failed: denied' })
  await assert.rejects(debugNative('footprint', 'return 1', { socket }), /denied/)
  assert.deepEqual(seen, ['debug', 'debug', 'eval', 'debug'])
})
