#!/usr/bin/env node
// `tilr-plugin`: the commands of a plugin repo, the same in every one (its package.json scripts
// call these). Shipped as the bin of @tilr-dev/plugin.
//
//   tilr-plugin build [--watch] [--install] [--site DIR]
//                     build into dist/: the repo's build.mjs when it has one (run with these
//                     flags), else buildPlugin() with the defaults (@tilr-dev/plugin/build)
//   tilr-plugin dev [--site DIR]
//                     build --watch --install: rebuild on every save, install into the Tilr site
//   tilr-plugin install-site [--site DIR]
//                     dist/ → plugins/<name>/ of the Tilr site, the name appended to plugins.json
//                     (--site DIR, $TILR_SITE, the app's config, the default; see the README)
//   tilr-plugin verify [--full] [--no-runtime] [--skip a,b] [--only a,b]
//                     the repo standard's checks: format, lint, types, api, unit, dupes, unused,
//                     secrets, deps (+ e2e, pack with --full); the first failure stops (verify.mjs);
//                     --no-runtime ($TILR_NO_RUNTIME=1) skips api, e2e, pack (need web / site/)
//   tilr-plugin hook pre-commit <files…> | hook commit-msg <file>
//                     what the git hooks run (presets/lefthook.yml)
//
// Run in the plugin repo (npm scripts are). Exits 1 on a failed build, install, check or hook.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildPlugin, checkNode, installPlugin } from './build-plugin.mjs'
import { parseVerifyArgs, runHook, runSteps, selectSteps } from './verify.mjs'

const usage = () => {
  console.error(
    'usage: tilr-plugin build [--watch] [--install] [--site DIR] | dev [--site DIR] | install-site [--site DIR]\n' +
      '       tilr-plugin verify [--full] [--no-runtime] [--skip a,b] [--only a,b] | hook pre-commit <files…> | hook commit-msg <file>',
  )
  process.exit(2)
}

/** Builds with the repo's build.mjs (in a child Node, the flags passed on) or the defaults. */
async function build(argv, root = process.cwd()) {
  const script = join(root, 'build.mjs')
  if (existsSync(script)) {
    const child = spawnSync(process.execPath, [script, ...argv], { cwd: root, stdio: 'inherit' })
    if (child.error) throw child.error
    if (child.status !== 0) process.exitCode = child.status ?? 1
    return
  }
  await buildPlugin({ root, argv })
}

const [command, ...args] = process.argv.slice(2)
try {
  checkNode()
  switch (command) {
    case 'build':
      await build(args)
      break
    case 'dev':
      await build([...new Set(['--watch', '--install', ...args])])
      break
    case 'install-site':
      await installPlugin({ argv: args })
      break
    case 'verify': {
      const options = parseVerifyArgs(args)
      if (!runSteps(selectSteps(options), { noRuntime: options.noRuntime }).ok) process.exitCode = 1
      break
    }
    case 'hook':
      if (!runHook(args[0], args.slice(1))) process.exitCode = 1
      break
    default:
      usage()
  }
} catch (error) {
  console.error(`[tilr-plugin] ${error.message}`)
  process.exitCode = 1
}
