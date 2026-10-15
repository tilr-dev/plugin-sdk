#!/usr/bin/env node
// `tilr-plugin`: the commands of a plugin repo, the same in every one (its package.json scripts
// call these). Shipped as a bin of @tilr-dev/plugin, next to `tilr` (the app's command).
//
//   tilr-plugin build [--watch] [--install] [--site DIR]
//                     build into dist/: the repo's build.mjs when it has one (run with these
//                     flags), else buildPlugin() with the defaults (@tilr-dev/plugin/build)
//   tilr-plugin dev [--site DIR]
//                     build --watch --install: rebuild on every save, install into the Tilr site
//   tilr-plugin install-site [--site DIR]
//                     dist/ → plugins/<name>/ of the Tilr site, the name appended to plugins.json
//                     (--site DIR, $TILR_SITE, the app's config, the default; see the README)
//
// Run in the plugin repo (npm scripts are). Exits 1 on a failed build or install.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildPlugin, checkNode, installPlugin } from './build-plugin.mjs'

const usage = () => {
  console.error('usage: tilr-plugin build [--watch] [--install] [--site DIR] | dev [--site DIR] | install-site [--site DIR]')
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
    case 'build': await build(args); break
    case 'dev': await build([...new Set(['--watch', '--install', ...args])]); break
    case 'install-site': await installPlugin({ argv: args }); break
    default: usage()
  }
} catch (error) {
  console.error(`[tilr-plugin] ${error.message}`)
  process.exitCode = 1
}
