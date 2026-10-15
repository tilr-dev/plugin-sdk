// `npm run sync:runtime [-- --build] [--force]` / `node scripts/sync-runtime.mjs --check`
//
// The SDK ships the core page, site/: what the e2e harness serves (coreSite()), what
// `@tilr-dev/plugin/test/node` resolves 'tilr', 'tilr/ui', 'cordis', 'react' … to, and what the
// `tilr` bin installs into an app. It is built from the core repo (web/), so here it is a copy:
// gitignored, filled by this script, packed by `files`.
//
//   (default)  mirror web's built site/ into ./site (web/ untouched; run `npm run build` there
//              first if it is stale)
//   --build    build web's page into a temp folder with `node build.mjs --out DIR` (esbuild in
//              web/'s node_modules; it keeps its temp files in web/node_modules/.cache) and
//              mirror that, so web's own site/ is left as it is
//   --force    copy although web's package.json version differs from this package's
//   --check    copy nothing: fail unless ./site is a synced page of this package's version
//              (prepack runs it, so a tarball never ships without the page)
//
// site/.sync.json records what was copied: the version, web's commit, whether web was dirty.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PKG, ROOT, webDir, webVersion } from './web.mjs'

const SITE = join(ROOT, 'site')
const STAMP = join(SITE, '.sync.json')
// What the harness, the resolve hook and the `tilr` bin need from the page.
const REQUIRED = ['index.html', 'plugins.json', 'runtime.js', 'tilr.js', 'tilr/react.js', 'tilr/ui.js', 'tilr/native.js', 'vendor/cordis.js', 'vendor/react.js']
const argv = process.argv.slice(2)

function check() {
  const missing = REQUIRED.filter(file => !existsSync(join(SITE, file)))
  if (missing.length) throw new Error(`site/ has no ${missing.join(', ')}: run npm run sync:runtime`)
  const stamp = existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, 'utf8')) : null
  if (stamp?.version !== PKG.version) throw new Error(`site/ is the page of ${stamp?.version ?? 'an unknown version'}, the package is ${PKG.version}: run npm run sync:runtime`)
  return stamp
}

function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

function sync() {
  const web = webDir()
  const version = webVersion(web)
  if (version !== PKG.version && !argv.includes('--force')) {
    throw new Error(`${web} is ${version}, this package is ${PKG.version}: the page's API must be the package's (bump one, or --force)`)
  }
  let from = join(web, 'site')
  let temp = null
  if (argv.includes('--build')) {
    temp = mkdtempSync(join(tmpdir(), 'tilr-sdk-site-'))
    from = join(temp, 'site')
    execFileSync(process.execPath, ['build.mjs', '--out', from], { cwd: web, stdio: 'inherit' })
  }
  try {
    if (!existsSync(join(from, 'index.html'))) throw new Error(`${from} has no built page: run npm run build in ${web}, or sync with --build`)
    rmSync(SITE, { recursive: true, force: true })
    cpSync(from, SITE, { recursive: true, filter: path => !path.endsWith('.DS_Store') })
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
  const status = git(['status', '--porcelain'], web)
  const stamp = { version, commit: git(['rev-parse', 'HEAD'], web), dirty: status === null ? null : status !== '', built: argv.includes('--build') }
  writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`)
  console.log(`[sync] ${from} → site/ (${version}, web ${stamp.commit?.slice(0, 7) ?? '?'}${stamp.dirty ? ', dirty' : ''})`)
  check()
}

try {
  if (argv.includes('--check')) console.log(`[sync] site/ ok: ${JSON.stringify(check())}`)
  else sync()
} catch (error) {
  console.error(`[sync] ${error.message}`)
  process.exitCode = 1
}
