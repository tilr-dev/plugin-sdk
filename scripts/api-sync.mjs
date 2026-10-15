// `npm run api:check` / `npm run api:sync`
//
// api/ is the plugin API's committed snapshot: the declarations of web/'s src/tilr.ts,
// src/types.ts and src/tilr/{react,ui,native}, emitted by web's tsconfig.api.json. It is the
// source of truth for plugin repos (tsconfig.base.json maps 'tilr' to it). This script emits a
// fresh copy from the web checkout ($TILR_WEB_DIR, default ../../../web) with web's own
// TypeScript, into a temp folder (web/ is not written), and compares it with api/ file by file.
//
//   (default)  check: exit 1 when api/ differs from what web emits now
//   --write    replace api/ with the fresh emit; then set package.json `tilrApi` to the API
//              version web implements, and commit it as feat (or feat! for a break) so
//              release-please bumps the package (README, Versions)
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PKG, ROOT, webApi, webDir } from './web.mjs'

const API = join(ROOT, 'api')

/** File name → contents of the .d.ts files in `dir` ({} when it does not exist). */
function read(dir) {
  const out = {}
  let names = []
  try {
    names = readdirSync(dir, { recursive: true })
  } catch {}
  for (const name of names) if (String(name).endsWith('.d.ts')) out[name] = readFileSync(join(dir, name), 'utf8')
  return out
}

const web = webDir()
const fresh = mkdtempSync(join(tmpdir(), 'tilr-api-'))
try {
  execFileSync(
    process.execPath,
    [join(web, 'node_modules/typescript/bin/tsc'), '-p', join(web, 'tsconfig.api.json'), '--outDir', fresh],
    { cwd: web, stdio: 'inherit' },
  )
  const [want, have] = [read(fresh), read(API)]
  const stale = [...new Set([...Object.keys(want), ...Object.keys(have)])]
    .sort()
    .filter(name => want[name] !== have[name])
    .map(name => `  api/${name}${name in have ? (name in want ? ' differs' : ' should not exist') : ' is missing'}`)
  if (webApi(web) !== PKG.tilrApi)
    console.warn(`[api] note: web implements plugin API ${webApi(web)}, this package's tilrApi is ${PKG.tilrApi}`)
  if (!stale.length) console.log(`[api] api/ matches ${web}`)
  else if (process.argv.includes('--write')) {
    rmSync(API, { recursive: true, force: true })
    cpSync(fresh, API, { recursive: true })
    console.log(
      `[api] api/ updated from ${web}:\n${stale.join('\n')}\nSet tilrApi to web's API version and commit as feat (feat! for a break).`,
    )
  } else {
    console.error(`[api] api/ is out of date with ${web}: run npm run api:sync and bump tilrApi\n${stale.join('\n')}`)
    process.exitCode = 1
  }
} finally {
  rmSync(fresh, { recursive: true, force: true })
}
