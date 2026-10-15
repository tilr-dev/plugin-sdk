// Shared locations for the Mac shell and its Node installers/control client.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const expandHome = path => path.replace(/^~(?=$|\/)/, homedir())
export const DEFAULT_CONFIG = join(homedir(), 'Library', 'Application Support', 'dev.tilr.mac')
export const configDir = (env = process.env) => resolve(expandHome(env.TILR_CONFIG || DEFAULT_CONFIG))
export const defaultSite = (env = process.env) => join(configDir(env), 'apps', 'default')

/** The core plugins a kit has: `static/plugins.json` in a core (web) checkout, else
 *  `site/plugins.json` in the published @tilr-dev/plugin (its site/ is the core's build). */
export function corePlugins(kit) {
  const file = [join(kit, 'static/plugins.json'), join(kit, 'site/plugins.json')].find(path => existsSync(path))
  if (!file) throw new Error(`${kit}: no static/plugins.json or site/plugins.json (is the core page synced? npm run sync:runtime)`)
  return JSON.parse(readFileSync(file, 'utf8')).plugins
}
