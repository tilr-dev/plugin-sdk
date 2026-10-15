// `npm run sync:runtime [-- --build] [--force]` / `node scripts/sync-runtime.mjs --check`
//
// The SDK ships the core page, site/: what the e2e harness serves (coreSite()), what
// `@tilr-dev/plugin/test/node` resolves 'tilr', 'tilr/ui', 'cordis', 'react' … to, and what the
// `tilr` bin installs into an app. It is built from the core repo (web/), so here it is a copy:
// committed (CI and publishing need no web checkout), refreshed only on purpose by this script
// (in a PR of its own), packed by `files`.
//
//   (default)  mirror web's built site/ into ./site (web/ untouched; run `npm run build` there
//              first if it is stale)
//   --build    build web's page into a temp folder with `node build.mjs --out DIR` (esbuild in
//              web/'s node_modules; it keeps its temp files in web/node_modules/.cache) and
//              mirror that, so web's own site/ is left as it is
//   --force    copy although the page's plugin API version (web's package.json version, which
//              web's build.mjs defines as `window.tilr.api`) differs from this package's `tilrApi`
//   --check    copy nothing: fail unless ./site is a synced page of this package's `tilrApi`
//              (prepack runs it, so a tarball never ships without the page)
//
// The plugin API version (package.json `tilrApi`) is not the SDK's package version: release-please
// bumps `version` freely, `tilrApi` changes only with the api/ contract (npm run api:sync).
//
// site/.sync.json records what was copied: the page's plugin API version (`api`), web's package
// version and commit, whether web was dirty.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PKG, ROOT, webApi, webDir, webVersion } from './web.mjs'

const SITE = join(ROOT, 'site')
const STAMP = '.sync.json'
/** How much of the web commit the log shows (git's short hash). */
const SHORT_SHA_LENGTH = 7
// What the harness, the resolve hook and the `tilr` bin need from the page.
const REQUIRED = [
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
const argv = process.argv.slice(2)

/** The plugin API version of the page a site/.sync.json describes: its `api` (a stamp from before
 *  `api` was recorded has only web's `version`, which was the API then); null for none. */
export const stampApi = stamp => stamp?.api ?? stamp?.version ?? null

/** Throws unless `site` is a complete page whose stamp says it implements plugin API `api`
 *  (default: this package's `tilrApi`); returns the stamp. */
export function check(site = SITE, api = PKG.tilrApi) {
  const missing = REQUIRED.filter(file => !existsSync(join(site, file)))
  if (missing.length) throw new Error(`site/ has no ${missing.join(', ')}: run npm run sync:runtime`)
  const file = join(site, STAMP)
  const stamp = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  if (stampApi(stamp) !== api) {
    throw new Error(
      `site/ is the page of plugin API ${stampApi(stamp) ?? 'unknown'}, this package's tilrApi is ${api}: run npm run sync:runtime`,
    )
  }
  return stamp
}

/** Throws unless the plugin API web implements (`have`) is this package's `tilrApi` (`want`),
 *  or `force`. */
export function checkWebApi(have, want = PKG.tilrApi, { web = 'web', force = false } = {}) {
  if (have === want || force) return
  throw new Error(
    `${web} implements plugin API ${have}, this package's tilrApi is ${want}: sync api/ and bump tilrApi (README, Versions), or --force`,
  )
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function sync() {
  const web = webDir()
  const api = webApi(web)
  const force = argv.includes('--force')
  checkWebApi(api, PKG.tilrApi, { web, force })
  let from = join(web, 'site')
  let temp = null
  if (argv.includes('--build')) {
    temp = mkdtempSync(join(tmpdir(), 'tilr-sdk-site-'))
    from = join(temp, 'site')
    execFileSync(process.execPath, ['build.mjs', '--out', from], { cwd: web, stdio: 'inherit' })
  }
  try {
    if (!existsSync(join(from, 'index.html')))
      throw new Error(`${from} has no built page: run npm run build in ${web}, or sync with --build`)
    rmSync(SITE, { recursive: true, force: true })
    cpSync(from, SITE, { recursive: true, filter: path => !path.endsWith('.DS_Store') })
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
  const status = git(['status', '--porcelain'], web)
  const stamp = {
    api,
    version: webVersion(web),
    commit: git(['rev-parse', 'HEAD'], web),
    dirty: status === null ? null : status !== '',
    built: argv.includes('--build'),
  }
  writeFileSync(join(SITE, STAMP), `${JSON.stringify(stamp, null, 2)}\n`)
  console.log(
    `[sync] ${from} → site/ (api ${api}, web ${stamp.version} ${stamp.commit?.slice(0, SHORT_SHA_LENGTH) ?? '?'}${stamp.dirty ? ', dirty' : ''})`,
  )
  // A forced copy is checked against what was copied; `--check` (and prepack) still wants tilrApi.
  check(SITE, force ? api : PKG.tilrApi)
}

function main() {
  try {
    if (argv.includes('--check')) console.log(`[sync] site/ ok: ${JSON.stringify(check())}`)
    else sync()
  } catch (error) {
    console.error(`[sync] ${error.message}`)
    process.exitCode = 1
  }
}

// Run as a script; the unit tests import check and checkWebApi without running anything.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
