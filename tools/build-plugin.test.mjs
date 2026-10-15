// @tilr-dev/plugin/build (tools/build-plugin.mjs) on fixture plugins in temp folders: each build
// runs in a child Node, as a plugin's `node build.mjs` would.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMPORT_MAP, checkNode, stamp } from './build-plugin.mjs'

const BUILD = new URL('./build-plugin.mjs', import.meta.url).href
const KIT = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A plugin repo in a temp folder: package.json + `files` (path → text). */
function fixture(files, pkg = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tilr-build-plugin-'))
  dirs.push(root)
  write(root, {
    'package.json': JSON.stringify({ name: '@tilr-dev/plugin-fix', version: '1.2.3', type: 'module', ...pkg }),
    ...files,
  })
  return root
}

function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

/** Writes `root`/build.mjs, `buildPlugin(<options>)` (source text), as a plugin repo has it. */
function script(root, options = '{}') {
  writeFileSync(
    join(root, 'build.mjs'),
    `import { buildPlugin } from ${JSON.stringify(BUILD)}\nawait buildPlugin(${options})\n`,
  )
}

/** `node build.mjs --watch` in `root`: the child, its output so far, and how many builds it logged. */
function watchBuild(root) {
  const child = spawn(process.execPath, ['build.mjs', '--watch'], { cwd: root })
  let output = ''
  child.stdout.on('data', data => {
    output += data
  })
  child.stderr.on('data', data => {
    output += data
  })
  const log = () => output
  const builds = () =>
    output.split('\n').filter(line => line.startsWith('[build] ') && line.includes('dist/index.js')).length
  return { child, log, builds }
}

/** `node build.mjs` in `root`, with `buildPlugin(<options>)`. */
function build(root, options = '{}', argv = []) {
  script(root, options)
  const r = spawnSync(process.execPath, ['build.mjs', ...argv], { cwd: root, encoding: 'utf8' })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

const read = (root, path) => readFileSync(join(root, path), 'utf8')
const list = dir =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => join(d.parentPath, d.name).slice(dir.length + 1))
    .sort()

const PLUGIN = {
  'src/index.ts': `import { definePlugin } from 'tilr'
import type {} from '@tilr-dev/plugin-menu/api'
import { greet } from './helper.ts'
export default definePlugin({ name: 'fix', inject: ['ui'], apply(ctx) { ctx.ui.tile().textContent = greet(__TILR_VERSION__, __TILR_API__) } })
`,
  'src/helper.ts': `export const greet = (v: string, api: string): string => 'hi ' + v + ' ' + api\n`,
  'src/api.ts': `export interface Fix { hello(): void }\n`,
  'src/style.css': `.fix { color: red }\n`,
  'src/img/icon.svg': `<svg/>`,
  'src/index.test.ts': `throw new Error('never built')\n`,
  'src/.index.ts.swp': 'junk',
  'src/notes.bin': 'not an asset',
}

describe('buildPlugin', () => {
  test('bundles src/index.ts, defines the versions, stamps them, copies api.d.ts and the assets', () => {
    const root = fixture(PLUGIN)
    const r = build(root)
    assert.equal(r.status, 0, r.output)
    assert.deepEqual(list(join(root, 'dist')), ['api.d.ts', 'img/icon.svg', 'index.js', 'index.js.map', 'style.css'])
    const js = read(root, 'dist/index.js')
    assert.match(js, /from "tilr"/) // the import map's, left as is
    assert.doesNotMatch(js, /from "\.\/helper/) // bundled
    assert.doesNotMatch(js, /__TILR_(VERSION|API)__/)
    assert.ok(js.includes(`greet("1.2.3", ${JSON.stringify(KIT.version)})`), js)
    // Without an installed @tilr-dev/plugin the API is this package's own version.
    assert.ok(
      js.includes(
        `export const __tilrBuild = {"version":"1.2.3","api":"^${KIT.version}"};\n//# sourceMappingURL=index.js.map`,
      ),
      js,
    )
    assert.equal(read(root, 'dist/api.d.ts'), PLUGIN['src/api.ts'])
    assert.deepEqual(JSON.parse(read(root, 'dist/index.js.map')).sources, ['../src/index.ts', '../src/helper.ts'])
    assert.match(
      r.output,
      /\[build\] \d+ms: dist\/index\.js \(\d+K\) dist\/api\.d\.ts dist\/img\/icon\.svg dist\/style\.css \(version 1\.2\.3, api \^/,
    )
  })

  test("__TILR_API__ is the installed @tilr-dev/plugin's version", () => {
    const root = fixture({
      ...PLUGIN,
      'node_modules/@tilr-dev/plugin/package.json': JSON.stringify({
        name: '@tilr-dev/plugin',
        version: '9.8.7',
        exports: { './package.json': './package.json' },
      }),
    })
    const r = build(root)
    assert.equal(r.status, 0, r.output)
    const js = read(root, 'dist/index.js')
    assert.ok(js.includes('greet("1.2.3", "9.8.7")'), js)
    assert.ok(js.includes('{"version":"1.2.3","api":"^9.8.7"}'), js)
  })

  test('builds into a temp folder and replaces dist/ only when complete; a failure keeps the last good dist/', () => {
    const root = fixture(PLUGIN)
    assert.equal(build(root).status, 0)
    const good = read(root, 'dist/index.js')
    writeFileSync(join(root, 'dist/marker'), 'from the last good build')

    // A syntax error: exit 1, dist/ untouched.
    write(root, { 'src/helper.ts': 'export const greet = (\n' })
    const broken = build(root)
    assert.equal(broken.status, 1)
    assert.match(broken.output, /src\/helper\.ts/)
    assert.equal(read(root, 'dist/index.js'), good)
    assert.ok(existsSync(join(root, 'dist/marker')))

    // A failing hook: same.
    write(root, { 'src/helper.ts': PLUGIN['src/helper.ts'] })
    const hook = build(root, `{ hooks: { after() { throw new Error('the hook failed') } } }`)
    assert.equal(hook.status, 1)
    assert.match(hook.output, /the hook failed/)
    assert.ok(existsSync(join(root, 'dist/marker')))

    // The hook writes into the temp folder, not into dist/; then dist/ is that folder.
    const ok = build(
      root,
      `{ hooks: { async after({ out, dist, files }) {
      const fs = await import('node:fs')
      if (out === dist || fs.existsSync(dist + '/extra.txt')) throw new Error('not a temp folder')
      if (!files.includes('index.js')) throw new Error('index.js missing')
      fs.writeFileSync(out + '/extra.txt', 'extra')
    } } }`,
    )
    assert.equal(ok.status, 0, ok.output)
    assert.equal(read(root, 'dist/extra.txt'), 'extra')
    assert.ok(!existsSync(join(root, 'dist/marker'))) // replaced as a whole
    assert.deepEqual(readdirSync(join(root, '.tilr-build')), []) // no temp folder left
  })

  test("dist/ gets a folder's usual mode (not the temp folder's 0700); a dead build's temp folders are swept, a live one's kept", () => {
    const root = fixture(PLUGIN)
    const plain = join(root, 'plain')
    mkdirSync(plain)
    const cache = join(root, '.tilr-build')
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    mkdirSync(join(cache, `out-${dead}-abcdef`, 'dist'), { recursive: true })
    mkdirSync(join(cache, `out-${process.pid}-abcdef`), { recursive: true })
    const r = build(root)
    assert.equal(r.status, 0, r.output)
    assert.equal(statSync(join(root, 'dist')).mode & 0o777, statSync(plain).mode & 0o777)
    assert.deepEqual(readdirSync(cache), [`out-${process.pid}-abcdef`])
  })

  test('dist/ as a symlink is replaced by a folder; what it pointed at is left as it was', () => {
    const root = fixture(PLUGIN)
    const elsewhere = join(root, 'elsewhere')
    write(root, { 'elsewhere/keep.txt': 'kept' })
    symlinkSync(elsewhere, join(root, 'dist'))
    const r = build(root)
    assert.equal(r.status, 0, r.output)
    assert.ok(lstatSync(join(root, 'dist')).isDirectory())
    assert.ok(existsSync(join(root, 'dist/index.js')))
    assert.deepEqual(readdirSync(elsewhere), ['keep.txt'])
  })

  test("an entry given as './src/index.ts' is the entry (no warning about itself); an entry at the root copies nothing from node_modules/ or dist/", () => {
    const dotted = fixture({ 'src/index.ts': `export default { name: 'fix', apply() {} }\n` })
    const r = build(dotted, `{ bundle: false, entry: './src/index.ts' }`)
    assert.equal(r.status, 0, r.output)
    assert.doesNotMatch(r.output, /skipped/)

    const flat = fixture({
      'index.ts': `export default { name: 'fix', apply() {} }\n`,
      'style.css': '.fix {}\n',
      'node_modules/lib/package.json': '{}',
    })
    assert.equal(build(flat, `{ entry: 'index.ts' }`).status, 0)
    write(flat, { 'dist/stale.json': '{}' })
    const again = build(flat, `{ entry: 'index.ts' }`)
    assert.equal(again.status, 0, again.output)
    const out = list(join(flat, 'dist'))
    assert.ok(out.includes('style.css'), out.join(' '))
    assert.ok(!out.some(path => path.startsWith('node_modules') || path.startsWith('dist')), out.join(' '))
  })

  test('bundle: false strips the entry alone, and fails on an import the page cannot resolve', () => {
    const allowed = fixture({
      'src/index.tsx': `import { definePlugin } from 'tilr'
import { Frame } from 'tilr/ui'
import type {} from '@tilr-dev/plugin-menu/api'
export default definePlugin({ name: 'fix', apply() { void (<Frame />) } })
`,
    })
    const ok = build(allowed, '{ bundle: false }')
    assert.equal(ok.status, 0, ok.output)
    const js = read(allowed, 'dist/index.js')
    assert.match(js, /from "tilr"/)
    assert.match(js, /from "react\/jsx-runtime"/)
    assert.match(js, /\/\/# sourceMappingURL=data:application\/json;base64,/)
    assert.ok(js.includes('export const __tilrBuild = '))

    const foreign = fixture({
      'src/index.ts': `import { definePlugin } from 'tilr'\nimport lodash from 'lodash'\nexport default definePlugin({ name: 'fix', apply() { lodash() } })\n`,
    })
    const bad = build(foreign, '{ bundle: false }')
    assert.equal(bad.status, 1)
    assert.match(
      bad.output,
      /src\/index\.ts imports 'lodash': only the page's import map resolves a bare name \(cordis, @deepseek-ai\/cosmokit, tilr, /,
    )
    assert.match(bad.output, /Bundle the plugin \(bundle: true\) or drop the import/)
    assert.ok(!existsSync(join(foreign, 'dist')))

    const relative = fixture({
      'src/index.ts': `import { x } from './util.ts'\nexport default { name: 'fix', apply() { x() } }\n`,
      'src/util.ts': 'export const x = (): void => {}\n',
    })
    const rel = build(relative, '{ bundle: false }')
    assert.equal(rel.status, 1)
    assert.match(rel.output, /src\/index\.ts imports '\.\/util\.ts': with bundle: false the plugin is this one file/)
  })

  test('--watch rebuilds on a change under src/ and of package.json', async () => {
    const root = fixture(PLUGIN)
    script(root)
    const { child, log, builds } = watchBuild(root)
    const until = async (check, what) => {
      for (let i = 0; i < 100 && !check(); i++) await new Promise(done => setTimeout(done, 50))
      assert.ok(check(), `${what}:\n${log()}`)
    }
    try {
      await until(() => log().includes('[build] watching'), 'the watch did not start')
      assert.equal(builds(), 1)
      write(root, { 'src/helper.ts': `export const greet = (v: string, api: string): string => 'hello ' + v + api\n` })
      await until(
        () => builds() === 2 && read(root, 'dist/index.js').includes('hello '),
        'no rebuild after a source change',
      )
      write(root, {
        'package.json': JSON.stringify({ name: '@tilr-dev/plugin-fix', version: '1.2.4', type: 'module' }),
      })
      await until(() => read(root, 'dist/index.js').includes('"version":"1.2.4"'), 'no rebuild after a version bump')
    } finally {
      child.kill()
    }
  })

  test('--watch: changes during a build make one more build, not one each', async () => {
    const root = fixture(PLUGIN)
    // A slow build (the hook waits 600 ms), and six changes 80 ms apart while it runs.
    script(root, `{ hooks: { after: () => new Promise(done => setTimeout(done, 600)) } }`)
    const { child, log, builds } = watchBuild(root)
    const sleep = ms => new Promise(done => setTimeout(done, ms))
    try {
      for (let i = 0; i < 100 && !log().includes('[build] watching'); i++) await sleep(50)
      assert.equal(builds(), 1, log())
      for (let i = 0; i < 6; i++) {
        write(root, {
          'src/helper.ts': `export const greet = (v: string, api: string): string => 'v${i} ' + v + api\n`,
        })
        await sleep(80)
      }
      // The first change starts a build, the rest wait as one: two builds, then quiet.
      await sleep(2500)
      assert.ok(builds() <= 3, `${builds()} builds:\n${log()}`)
      assert.match(read(root, 'dist/index.js'), /v5 /, log())
    } finally {
      child.kill()
    }
  })

  const SITE_INDEX = fileURLToPath(new URL('../site/index.html', import.meta.url))
  const NO_SITE = existsSync(SITE_INDEX)
    ? false
    : 'skipped: needs core page (web): site/ is missing, run npm run sync:runtime'
  test('IMPORT_MAP is the import map of site/index.html', { skip: NO_SITE }, () => {
    const html = readFileSync(SITE_INDEX, 'utf8')
    const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}')
    assert.deepEqual([...IMPORT_MAP].sort(), Object.keys(map.imports).sort())
  })

  test('checkNode explains an old Node', () => {
    assert.throws(() => checkNode('20.11.0', '>=22.18'), /@tilr-dev\/plugin needs Node >=22\.18; .* is v20\.11\.0/)
    assert.throws(() => checkNode('22.17.9', '>=22.18'), /needs Node/)
    checkNode('22.18.0', '>=22.18')
    checkNode('26.1.0', '>=22.18')
  })

  test('stamp() goes before the sourceMappingURL comment', () => {
    assert.equal(
      stamp('a\n//# sourceMappingURL=index.js.map\n', { version: '1.0.0', api: '0.1.14' }),
      'a\nexport const __tilrBuild = {"version":"1.0.0","api":"^0.1.14"};\n//# sourceMappingURL=index.js.map\n',
    )
    assert.equal(
      stamp('a', { version: '1.0.0', api: '0.1.14' }),
      'a\nexport const __tilrBuild = {"version":"1.0.0","api":"^0.1.14"};\n',
    )
    // The source's own __tilrBuild would be a second export of the name: the build says so.
    assert.throws(
      () => stamp('export const __tilrBuild = {};\n', { version: '1.0.0', api: '0.1.14' }),
      /has a __tilrBuild of its own/,
    )
  })
})
