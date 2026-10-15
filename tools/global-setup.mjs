// `@tilr-dev/plugin/test/global-setup`: Playwright's globalSetup for a plugin repo, one fresh
// build before the specs so they never test a stale dist/. Runs `tilr-plugin build` in the
// plugin's folder (the config file's): the plugin's build.mjs when it has one, else
// `buildPlugin()` with the defaults. `@tilr-dev/plugin/playwright` points at this file.
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('./tilr-plugin.mjs', import.meta.url))

export default function build(config) {
  const root = config?.configFile ? dirname(config.configFile) : process.cwd()
  execFileSync(process.execPath, [BIN, 'build'], { cwd: root, stdio: 'inherit' })
}
