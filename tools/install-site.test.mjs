// uninstallSite (tools/install-site.js) and `tilr-plugin uninstall-site` on sites in temp folders.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSite, uninstallSite } from './install-site.js'

const CLI = fileURLToPath(new URL('./tilr-plugin.mjs', import.meta.url))
const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A temp folder with `files` (path → text). */
function folder(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tilr-uninstall-'))
  dirs.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/** A site with the plugins `names` installed (and plugins.json listing them, with an extra key),
 *  in a folder of its own: the staging folders go next to it. */
function site(names) {
  const dir = join(folder({ 'site/index.html': '<!doctype html>' }), 'site')
  const list = { theme: 'dark', plugins: names }
  writeFileSync(join(dir, 'plugins.json'), `${JSON.stringify(list, null, 2)}\n`)
  for (const name of names) {
    mkdirSync(join(dir, 'plugins', name, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'plugins', name, 'index.js'), 'export default {}')
    writeFileSync(join(dir, 'plugins', name, 'assets', 'a.css'), '')
  }
  return dir
}

const list = dir => JSON.parse(readFileSync(join(dir, 'plugins.json'), 'utf8'))

test('uninstallSite: the name leaves plugins.json, its folder goes, the rest stays', async () => {
  const dir = site(['store', 'clock', 'layout'])
  assert.deepEqual(await uninstallSite({ site: dir, names: ['clock'] }), ['plugins.json', '-plugins/clock'])
  assert.deepEqual(list(dir), { theme: 'dark', plugins: ['store', 'layout'] })
  assert.ok(readFileSync(join(dir, 'plugins.json'), 'utf8').endsWith(']\n}\n'))
  assert.equal(existsSync(join(dir, 'plugins', 'clock')), false)
  assert.ok(existsSync(join(dir, 'plugins', 'store', 'index.js')))
  // No staging folder left next to the site.
  assert.deepEqual(
    readdirSync(dirname(dir)).filter(name => name.startsWith('.tilr-install-')),
    [],
  )
})

test('uninstallSite: nothing there is a no-op', async () => {
  const dir = site(['store'])
  const before = readFileSync(join(dir, 'plugins.json'), 'utf8')
  assert.deepEqual(await uninstallSite({ site: dir, names: ['clock'] }), [])
  assert.equal(readFileSync(join(dir, 'plugins.json'), 'utf8'), before)
  assert.deepEqual(await uninstallSite({ site: join(dir, 'missing'), names: ['clock'] }), [])
})

test('uninstallSite: only one of the two there', async () => {
  const listed = site(['clock'])
  rmSync(join(listed, 'plugins', 'clock'), { recursive: true })
  assert.deepEqual(await uninstallSite({ site: listed, names: ['clock'] }), ['plugins.json'])
  const unlisted = site([])
  mkdirSync(join(unlisted, 'plugins', 'clock'), { recursive: true })
  assert.deepEqual(await uninstallSite({ site: unlisted, names: ['clock'] }), ['-plugins/clock'])
})

test('uninstallSite: refuses a bad name and a bad plugins.json', async () => {
  const dir = site(['store'])
  await assert.rejects(uninstallSite({ site: dir, names: ['../store'] }), /bad plugin name/)
  writeFileSync(join(dir, 'plugins.json'), '{"plugins": "store"}')
  await assert.rejects(uninstallSite({ site: dir, names: ['store'] }), /expected \{ "plugins": \[names\] \}/)
})

test('installSite then uninstallSite leaves the site as it was', async () => {
  const dir = site(['store'])
  const before = readFileSync(join(dir, 'plugins.json'), 'utf8')
  const dist = folder({ 'index.js': 'export default {}' })
  await installSite({ site: dir, plugins: { clock: dist } })
  assert.deepEqual(list(dir).plugins, ['store', 'clock'])
  await uninstallSite({ site: dir, names: ['clock'] })
  assert.equal(readFileSync(join(dir, 'plugins.json'), 'utf8'), before)
  assert.deepEqual(readdirSync(join(dir, 'plugins')), ['store'])
})

/** `tilr-plugin uninstall-site …` in the plugin repo `cwd`. */
const cli = (cwd, args) => spawnSync(process.execPath, [CLI, 'uninstall-site', ...args], { cwd, encoding: 'utf8' })

test('tilr-plugin uninstall-site: the repo name by default, or the one given; exit 0 when absent', () => {
  const repo = folder({ 'package.json': JSON.stringify({ name: 'tilr-plugin-clock', tilr: { name: 'clock' } }) })
  const dir = site(['store', 'clock', 'timer'])
  let run = cli(repo, ['--site', dir])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /\[uninstall\] .*: plugins\.json -plugins\/clock/)
  run = cli(repo, ['timer', '--site', dir])
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(list(dir).plugins, ['store'])
  run = cli(repo, ['--site', dir])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /no clock there, no change/)
})
