import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { corePlugins } from './paths.js'

test('corePlugins: static/plugins.json in a web checkout, else site/plugins.json in the package', async t => {
  const kit = await mkdtemp(join(tmpdir(), 'tilr-kit-'))
  t.after(() => rm(kit, { recursive: true, force: true }))
  assert.throws(() => corePlugins(kit), /no static\/plugins\.json or site\/plugins\.json/)
  await mkdir(join(kit, 'site'))
  await writeFile(join(kit, 'site/plugins.json'), JSON.stringify({ plugins: ['store', 'theme'] }))
  assert.deepEqual(corePlugins(kit), ['store', 'theme'])
  await mkdir(join(kit, 'static'))
  await writeFile(join(kit, 'static/plugins.json'), JSON.stringify({ plugins: ['store'] }))
  assert.deepEqual(corePlugins(kit), ['store'])
})
