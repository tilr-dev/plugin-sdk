import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { addSitePlugins, pluginTarget } from './plugin-target.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tilr-plugin-target-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const site = join(root, 'default')
  const kit = join(root, 'kit')
  const local = join(root, 'browser')
  const put = async (path, value) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, value)
  }
  await put(join(site, 'index.html'), 'original page')
  await put(join(site, 'plugins.json'), JSON.stringify({ plugins: ['terminal'], extra: true }))
  await put(join(site, 'plugins/terminal/index.js'), 'original terminal')
  await put(join(site, 'store.json'), 'original state')
  await put(join(kit, 'static/plugins.json'), JSON.stringify({ plugins: ['webviews'] }))
  await put(join(kit, 'site/plugins/webviews/index.js'), 'webviews')
  await put(join(local, 'package.json'), JSON.stringify({ name: '@tilr-dev/plugin-browser' }))
  await put(join(local, 'dist/index.js'), 'browser')
  return { root, site, kit, local, put }
}

test('standalone install preserves existing plugins, page and state; repeat is idempotent', async t => {
  const { site, kit, local } = await fixture(t)
  const args = { site, kit, sources: ['webviews', local] }
  const result = await addSitePlugins(args)
  assert.deepEqual(result.plugins, ['webviews', 'browser'])
  assert.deepEqual(JSON.parse(await readFile(join(site, 'plugins.json'), 'utf8')), {
    plugins: ['terminal', 'webviews', 'browser'],
    extra: true,
  })
  for (const [path, value] of [
    ['index.html', 'original page'],
    ['store.json', 'original state'],
    ['plugins/terminal/index.js', 'original terminal'],
    ['plugins/browser/index.js', 'browser'],
  ]) {
    assert.equal(await readFile(join(site, path), 'utf8'), value)
  }
  assert.deepEqual((await addSitePlugins(args)).changed, [])
})

test('only the actual managed site is associated with its parent manifest, including symlinks', async t => {
  const { root, site, put } = await fixture(t)
  await put(join(root, 'tilr.json'), '{"plugins":[]}')
  await mkdir(join(root, 'site'))
  assert.equal(pluginTarget({ site }).dir, null)
  const managed = pluginTarget({ site: join(root, 'site') })
  assert.equal(managed.dir, managed.site.replace(/\/site$/, ''))
  await symlink(join(root, 'site'), join(root, 'alias'))
  assert.deepEqual(pluginTarget({ site: join(root, 'alias') }), managed)
})

test('invalid sources, unsupported refs and missing builds never install earlier sources', async t => {
  const { site, kit, local } = await fixture(t)
  const before = await readFile(join(site, 'plugins.json'), 'utf8')
  for (const args of [
    { sources: [] },
    { sources: ['webviews', 'https://example.org/plugin.git'] },
    { sources: [local], ref: 'v1' },
  ])
    await assert.rejects(addSitePlugins({ site, kit, ...args }))
  await rm(join(local, 'dist/index.js'))
  await assert.rejects(addSitePlugins({ site, kit, sources: ['webviews', local] }), /no index.js/)
  assert.equal(await readFile(join(site, 'plugins.json'), 'utf8'), before)
  await assert.rejects(readFile(join(site, 'plugins/webviews/index.js')))
})

test('a failed local build leaves the running site untouched', async t => {
  const { site, kit, local, put } = await fixture(t)
  await put(join(local, 'package.json'), JSON.stringify({ name: 'browser', scripts: { build: 'exit 1' } }))
  await assert.rejects(addSitePlugins({ site, kit, sources: ['webviews', local] }), /build failed/)
  assert.deepEqual(JSON.parse(await readFile(join(site, 'plugins.json'), 'utf8')).plugins, ['terminal'])
})

test('local build output, including a custom dist directory, is installed', async t => {
  const { site, kit, local, put } = await fixture(t)
  await put(
    join(local, 'package.json'),
    JSON.stringify({
      name: 'browser',
      tilr: { dist: 'output' },
      scripts: { build: 'node build.cjs' },
    }),
  )
  await put(
    join(local, 'build.cjs'),
    "require('fs').mkdirSync('output', {recursive:true}); require('fs').writeFileSync('output/index.js', 'fresh build')",
  )
  await addSitePlugins({ site, kit, sources: [local] })
  assert.equal(await readFile(join(site, 'plugins/browser/index.js'), 'utf8'), 'fresh build')
})

test('the MCP server publishes standalone installation support over stdio', () => {
  const result = spawnSync(process.execPath, [new URL('./tilr-mcp.mjs', import.meta.url).pathname], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const reply = JSON.parse(result.stdout)
  const tool = reply.result.tools.find(tool => tool.name === 'tilr_plugin')
  assert.match(tool.description, /a standalone site/)
  assert.deepEqual(tool.inputSchema.required, ['op'])
  assert.ok(tool.inputSchema.properties.op.enum.includes('add'))
  assert.equal(tool.inputSchema.properties.sources.type, 'array')
})
