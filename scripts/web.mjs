// Where the core repo (web/) is: $TILR_WEB_DIR, else ../../../web from this package (the layout
// tilr/clean/plugins/plugin-sdk next to tilr/web). The SDK reads it, never writes into it.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

/** The web checkout; throws when it is not one. */
export function webDir(env = process.env) {
  const dir = resolve(ROOT, env.TILR_WEB_DIR || '../../../web')
  if (!existsSync(resolve(dir, 'tsconfig.api.json')) || !existsSync(resolve(dir, 'build.mjs'))) {
    throw new Error(`${dir} is not a Tilr core (web) checkout: set TILR_WEB_DIR`)
  }
  return dir
}

/** web's package.json version: the plugin API its page implements. */
export const webVersion = dir => JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).version
