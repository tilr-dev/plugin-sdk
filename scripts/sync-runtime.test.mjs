// The checks of sync-runtime.mjs: site/ and web are compared by plugin API version (package.json
// `tilrApi`), never by the SDK's package version.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { check, checkWebApi, stampApi } from './sync-runtime.mjs'
import { PKG } from './web.mjs'

const PAGE = [
  'index.html',
  'plugins.json',
  'runtime.js',
  'tilr.js',
  'tilr/react.js',
  'tilr/ui.js',
  'tilr/native.js',
  'vendor/cordis.js',
  'vendor/react.js',
]
const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A site/ folder with the page's files and `stamp` as .sync.json (none when null). */
function site(stamp, files = PAGE) {
  const dir = mkdtempSync(join(tmpdir(), 'tilr-sync-test-'))
  temps.push(dir)
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), '')
  }
  if (stamp) writeFileSync(join(dir, '.sync.json'), JSON.stringify(stamp))
  return dir
}

describe('package.json', () => {
  test('declares tilrApi, the plugin API version, separate from the package version', () => {
    assert.match(PKG.tilrApi, /^\d+\.\d+\.\d+$/)
  })
})

describe('stampApi', () => {
  test("is the stamp's api, else (an older stamp) its version, else null", () => {
    assert.equal(stampApi({ api: '0.1.14', version: '0.2.0' }), '0.1.14')
    assert.equal(stampApi({ version: '0.1.14' }), '0.1.14')
    assert.equal(stampApi(null), null)
  })
})

describe('check', () => {
  test("passes when the stamp's api is tilrApi, whatever the web and package versions", () => {
    const stamp = { api: '0.1.14', version: '0.3.0', commit: 'abc' }
    assert.deepEqual(check(site(stamp), '0.1.14'), stamp)
  })

  test("fails when the stamp's api is not tilrApi", () => {
    assert.throws(
      () => check(site({ api: '0.1.13', version: '0.1.14' }), '0.1.14'),
      /plugin API 0\.1\.13.*tilrApi is 0\.1\.14/,
    )
  })

  test('fails without a stamp', () => {
    assert.throws(() => check(site(null), '0.1.14'), /plugin API unknown/)
  })

  test('fails when a file of the page is missing', () => {
    assert.throws(() => check(site({ api: '0.1.14' }, PAGE.slice(1)), '0.1.14'), /site\/ has no index\.html/)
  })

  test("defaults to this package's tilrApi", () => {
    assert.ok(check(site({ api: PKG.tilrApi })))
  })
})

describe('checkWebApi', () => {
  test("passes when web's API is tilrApi", () => {
    assert.doesNotThrow(() => checkWebApi('0.1.14', '0.1.14'))
  })

  test("fails when web's API differs from tilrApi, naming both", () => {
    assert.throws(
      () => checkWebApi('0.2.0', '0.1.14', { web: '/w' }),
      /\/w implements plugin API 0\.2\.0.*tilrApi is 0\.1\.14/,
    )
  })

  test('passes with force', () => {
    assert.doesNotThrow(() => checkWebApi('0.2.0', '0.1.14', { force: true }))
  })
})

describe('site/ (committed)', () => {
  test("is a synced page of this package's tilrApi", () => {
    assert.equal(stampApi(check()), PKG.tilrApi)
  })
})
