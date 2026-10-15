// Shared locations of the Mac shell for the Node installers.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const expandHome = path => path.replace(/^~(?=$|\/)/, homedir())
export const DEFAULT_CONFIG = join(homedir(), 'Library', 'Application Support', 'dev.tilr.mac')
export const configDir = (env = process.env) => resolve(expandHome(env.TILR_CONFIG || DEFAULT_CONFIG))
export const defaultSite = (env = process.env) => join(configDir(env), 'apps', 'default')
