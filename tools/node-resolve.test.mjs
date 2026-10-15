// @tilr-dev/plugin/test/node (tools/node-resolve.mjs): a plugin built with buildPlugin, whose
// dist/index.js imports 'tilr' and 'tilr/ui' bare, is imported in a child Node with and without
// the hook. A child, because this run's own --import (test/resolve-tilr.mjs) maps 'tilr' already.
// The hook needs site/ (the core page, from web by `npm run sync:runtime`): without it these
// tests are skipped, not failed (CI runs without web for now).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildPlugin } from './build-plugin.mjs'

const HOOK = new URL('./node-resolve.mjs', import.meta.url).href
const SDK = fileURLToPath(new URL('..', import.meta.url))
/** A skip reason when there is no core page (node:test `skip`), else false. */
const NO_SITE = existsSync(join(SDK, 'site/tilr/ui.js'))
  ? false
  : 'skipped: needs core page (web): site/ is missing, run npm run sync:runtime'
const root = mkdtempSync(join(tmpdir(), 'tilr-node-resolve-'))
after(() => rmSync(root, { recursive: true, force: true }))

mkdirSync(join(root, 'src'))
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ name: '@tilr-dev/plugin-fix', version: '1.2.3', type: 'module' }),
)
writeFileSync(
  join(root, 'src/index.ts'),
  `import { definePlugin, optional, onLayout } from 'tilr'
import { element, frame } from 'tilr/ui'
export default definePlugin({
  name: 'fix',
  inject: ['ui'],
  apply(ctx) {
    optional(ctx, 'layout', ctx => { onLayout(ctx, () => {}, { ignore: ['title'] }) })
    frame(ctx.ui.tile()).body.append(element('div', 'fix', 'hi'))
  },
})
export const helpers = { optional, onLayout, element, frame }
`,
)
const built = NO_SITE ? null : buildPlugin({ root, argv: [] })
const INDEX = pathToFileURL(join(root, 'dist/index.js')).href

/** Imports dist/index.js in a child Node (`args` before the script) and prints what it got. */
function load(args) {
  const script = `const m = await import(${JSON.stringify(INDEX)})
console.log(JSON.stringify({ name: m.default.name, inject: m.default.inject, apply: typeof m.default.apply,
  helpers: Object.fromEntries(Object.entries(m.helpers).map(([k, v]) => [k, typeof v])), stamp: m.__tilrBuild }))`
  const r = spawnSync(process.execPath, [...args, '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('the fixture builds, its imports left bare', { skip: NO_SITE }, async () => {
  assert.ok(await built)
  const js = readFileSync(join(root, 'dist/index.js'), 'utf8')
  assert.match(js, /from ["']tilr["']/)
  assert.match(js, /from ["']tilr\/ui["']/)
})

test('under the hook, dist/index.js imports the real SDK modules', { skip: NO_SITE }, async () => {
  await built
  const r = load(['--import', HOOK])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), {
    name: 'fix',
    inject: ['ui'],
    apply: 'function',
    helpers: { optional: 'function', onLayout: 'function', element: 'function', frame: 'function' },
    stamp: {
      version: '1.2.3',
      api: '^' + JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).tilrApi,
    },
  })
})

test('without the hook, the same import fails on the bare name', { skip: NO_SITE }, async () => {
  await built
  const r = load([])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /ERR_MODULE_NOT_FOUND/)
  assert.match(r.stderr, /'tilr(\/ui)?'/)
})

test('the hook maps every name of the import map, to the files site/index.html names', { skip: NO_SITE }, () => {
  const html = readFileSync(fileURLToPath(new URL('../site/index.html', import.meta.url)), 'utf8')
  const { imports } = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1])
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { SITE_FILES } from ${JSON.stringify(HOOK)}; console.log(JSON.stringify(SITE_FILES))`,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(
    JSON.parse(r.stdout),
    Object.fromEntries(Object.entries(imports).map(([k, v]) => [k, v.replace(/^\.\//, '')])),
  )
})
