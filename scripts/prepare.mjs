// `npm run prepare` (npm runs it after `npm install` in this repo): installs the git hooks
// (lefthook.yml) into this checkout. A no-op where there is nothing to install them into or with:
// on CI, outside a git checkout (an unpacked tarball), or without lefthook (a devDependency, so
// absent when this package is installed as a dependency). Never fails the install.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isCI, packageBin } from '../tools/verify.mjs'
import { ROOT } from './web.mjs'

const lefthook = packageBin('lefthook', 'lefthook', [ROOT])
if (isCI() || !existsSync(join(ROOT, '.git')) || !lefthook) {
  console.log('[prepare] git hooks not installed (CI, not a git checkout, or no lefthook)')
} else {
  const child = spawnSync(process.execPath, [lefthook, 'install'], { cwd: ROOT, stdio: 'inherit' })
  if (child.status !== 0) console.warn('[prepare] lefthook install failed; run npx lefthook install')
}
