// Installing into a Tilr site: the folder the Mac app serves (default <config>/apps/default), shared by the core
// (`npm run install:site` in the core repo: the page and its own plugins) and by plugin repos
// (their dist/ as plugins/<name>/). Shipped as `@tilr-dev/plugin/install`. Node only, no
// dependencies.
//
// The rules, the same for every installer:
// - The site is, first that is set: --site DIR, $TILR_SITE, `site:` in the selected config folder’s config.yml,
//   then <config>/apps/default (the app's default).
// - An installer replaces only what it owns: the plugin folders it brings are mirrored (files the
//   source no longer has are removed); every other plugin folder is left alone.
// - plugins.json is merged: existing entries keep their order, the installer's names that are
//   missing are appended. Nothing is removed from it. A site without one gets it, empty if the
//   installer brings no names.
// - The app watches the site and hot-reloads what changes, so a file is written only when its
//   bytes differ, atomically (staged next to the site folder, renamed into place), a plugin's
//   index.js after its assets, plugins.json after the plugin folders, index.html last.
// - Uninstalling is the reverse: the names leave plugins.json first (the page stops loading
//   them), then their folders go (moved out of the site at once, then deleted).
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { configDir, defaultSite, expandHome } from './paths.js'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** The app's default when nothing is set. */
export const DEFAULT_SITE = defaultSite()

const expand = expandHome

/** `site:` in the app's config (a top-level `key: value` line, not YAML in general), `~`
 *  expanded; null without the file or the key. */
export function configSite(file = join(configDir(), 'config.yml')) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const value = /^site:[ \t]*(.*?)[ \t]*(?:[ \t]#.*)?$/m.exec(text)?.[1].replace(/^(['"])(.*)\1$/, '$2')
  return value ? resolve(dirname(file), expand(value)) : null
}

/** The site folder: --site DIR, $TILR_SITE, the app's config, <config>/apps/default; in that order. */
export function siteDir(argv = process.argv.slice(2), env = process.env) {
  const flag = argv.indexOf('--site')
  if (flag !== -1 && !argv[flag + 1]) throw new Error('--site needs a folder')
  return resolve(
    expand(
      flag !== -1
        ? argv[flag + 1]
        : env.TILR_SITE || configSite(join(configDir(env), 'config.yml')) || defaultSite(env),
    ),
  )
}

/** What a plugin name may be: a folder name under plugins/, safe in a URL and a CSS class. */
export const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/i

/** The plugin's folder name in a plugin repo: package.json's `tilr.name`, or the package name
 *  without its scope and `plugin-` prefix (@tilr-dev/plugin-clock → clock). */
export function pluginName(pkg) {
  const name = pkg.tilr?.name ?? pkg.name.replace(/^@[^/]+\//, '').replace(/^plugin-/, '')
  if (!PLUGIN_NAME.test(name)) throw new Error(`bad plugin name '${name}' (set "tilr": { "name": … } in package.json)`)
  return name
}

/** Relative paths of the files under `dir` (dotfiles skipped), sorted. */
async function files(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const d of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (d.isFile() && !d.name.startsWith('.')) out.push(relative(dir, join(d.parentPath, d.name)))
  }
  return out.sort()
}

const real = path => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
const inside = (path, dir) => path === dir || path.startsWith(dir + sep)

/** Names of the staged files (in a fresh temp folder per install, so a counter is enough). */
let staging = 0

/** Writes `data` to `site`/`path` atomically: staged in `temp` (same file system), renamed in. */
async function writeAtomic(site, temp, path, data) {
  const target = join(site, path)
  await mkdir(dirname(target), { recursive: true })
  const staged = join(temp, String(staging++))
  await writeFile(staged, data)
  await rename(staged, target)
}

/** plugins.json with the names of `list` it lacks appended, through `put`. Written when names
 *  are missing, and when the file is: the page needs one even if empty. */
async function mergeList(site, list, put) {
  const json = join(site, 'plugins.json')
  const current = existsSync(json) ? JSON.parse(await readFile(json, 'utf8')) : { plugins: [] }
  if (!Array.isArray(current.plugins)) throw new Error(`${json}: expected { "plugins": [names] }`)
  const missing = list.filter(name => !current.plugins.includes(name))
  if (missing.length || !existsSync(json))
    await put(
      'plugins.json',
      Buffer.from(`${JSON.stringify({ ...current, plugins: [...current.plugins, ...missing] }, null, 2)}\n`),
    )
}

/**
 * Installs into `site`:
 * - `root`: a folder whose files are copied to the site's top level, except `plugins/` and
 *   `plugins.json` (the core's built site/), and `store.json` (an app's seed). Nothing at the top level is removed.
 * - `plugins`: name → folder, each mirrored to plugins/<name>/.
 * - `list`: the names to have in plugins.json (merged, see above).
 * Resolves to the changed site paths (`-path` for a removal); empty when nothing differed.
 */
export async function installSite({ site, root = null, plugins = {}, list = Object.keys(plugins) }) {
  site = resolve(site)
  for (const from of [root, ...Object.values(plugins)].filter(Boolean)) {
    if (inside(real(site), real(from)) || inside(real(from), real(site)))
      throw new Error(`refusing to install ${from} into ${site}: one is inside the other`)
  }
  await mkdir(site, { recursive: true })
  // Same filesystem as the site (rename is atomic), outside it (the app sees no temp files).
  const temp = await mkdtemp(join(dirname(site), '.tilr-install-'))
  const changed = []
  const put = async (path, data) => {
    const target = join(site, path)
    try {
      if (Buffer.compare(await readFile(target), data) === 0) return
    } catch {}
    await writeAtomic(site, temp, path, data)
    changed.push(path)
  }
  try {
    for (const [name, from] of Object.entries(plugins)) {
      if (!existsSync(join(from, 'index.js'))) throw new Error(`${from}: no index.js to install as plugins/${name}/`)
      const want = (await files(from)).sort((a, b) => (a === 'index.js') - (b === 'index.js'))
      for (const file of want) await put(join('plugins', name, file), await readFile(join(from, file)))
      for (const file of await files(join(site, 'plugins', name))) {
        if (want.includes(file)) continue
        await rm(join(site, 'plugins', name, file))
        changed.push(`-${join('plugins', name, file)}`)
      }
    }
    await mergeList(site, list, put)
    if (root) {
      // store.json is the app's (its seed, from a template), never the kit's.
      const top = (await files(root))
        .filter(file => file !== 'plugins.json' && file !== 'store.json' && !file.startsWith(`plugins${sep}`))
        .sort((a, b) => (a === 'index.html') - (b === 'index.html'))
      for (const file of top) await put(file, await readFile(join(root, file)))
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  return changed
}

/**
 * Uninstalls `names` from `site`: each leaves plugins.json (other entries and keys kept), then its
 * plugins/<name>/ folder is removed. A name that is in neither is skipped. Resolves to the changed
 * site paths (`-plugins/<name>` for a removed folder); empty when nothing was there.
 */
export async function uninstallSite({ site, names }) {
  site = resolve(site)
  for (const name of names) if (!PLUGIN_NAME.test(name)) throw new Error(`bad plugin name '${name}'`)
  if (!existsSync(site)) return []
  const changed = []
  const temp = await mkdtemp(join(dirname(site), '.tilr-install-'))
  try {
    const json = join(site, 'plugins.json')
    if (existsSync(json)) {
      const current = JSON.parse(await readFile(json, 'utf8'))
      if (!Array.isArray(current.plugins)) throw new Error(`${json}: expected { "plugins": [names] }`)
      const kept = current.plugins.filter(name => !names.includes(name))
      if (kept.length !== current.plugins.length) {
        const text = `${JSON.stringify({ ...current, plugins: kept }, null, 2)}\n`
        await writeAtomic(site, temp, 'plugins.json', Buffer.from(text))
        changed.push('plugins.json')
      }
    }
    for (const name of names) {
      const dir = join(site, 'plugins', name)
      if (!existsSync(dir)) continue
      // Out of the site in one rename (the app sees the folder go at once), then deleted.
      await rename(dir, join(temp, `plugin-${name}`))
      changed.push(`-${join('plugins', name)}`)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  return changed
}
