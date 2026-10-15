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
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const value = /^site:[ \t]*(.*?)[ \t]*(?:[ \t]#.*)?$/m.exec(text)?.[1].replace(/^(['"])(.*)\1$/, '$2')
  return value ? resolve(dirname(file), expand(value)) : null
}

/** The site folder: --site DIR, $TILR_SITE, the app's config, <config>/apps/default; in that order. */
export function siteDir(argv = process.argv.slice(2), env = process.env) {
  const flag = argv.indexOf('--site')
  if (flag !== -1 && !argv[flag + 1]) throw new Error('--site needs a folder')
  return resolve(expand(flag !== -1 ? argv[flag + 1] : env.TILR_SITE || configSite(join(configDir(env), 'config.yml')) || defaultSite(env)))
}

/** The plugin's folder name in a plugin repo: package.json's `tilr.name`, or the package name
 *  without its scope and `plugin-` prefix (@tilr-dev/plugin-clock → clock). */
export function pluginName(pkg) {
  const name = pkg.tilr?.name ?? pkg.name.replace(/^@[^/]+\//, '').replace(/^plugin-/, '')
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`bad plugin name '${name}' (set "tilr": { "name": … } in package.json)`)
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

const real = path => { try { return realpathSync(path) } catch { return resolve(path) } }
const inside = (path, dir) => path === dir || path.startsWith(dir + sep)

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
    if (inside(real(site), real(from)) || inside(real(from), real(site))) throw new Error(`refusing to install ${from} into ${site}: one is inside the other`)
  }
  await mkdir(site, { recursive: true })
  // Same filesystem as the site (rename is atomic), outside it (the app sees no temp files).
  const temp = await mkdtemp(join(dirname(site), '.tilr-install-'))
  const changed = []
  let n = 0
  const put = async (path, data) => {
    const target = join(site, path)
    try { if (Buffer.compare(await readFile(target), data) === 0) return } catch {}
    await mkdir(dirname(target), { recursive: true })
    const staged = join(temp, String(n++))
    await writeFile(staged, data)
    await rename(staged, target)
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
    const json = join(site, 'plugins.json')
    const current = existsSync(json) ? JSON.parse(await readFile(json, 'utf8')) : { plugins: [] }
    if (!Array.isArray(current.plugins)) throw new Error(`${json}: expected { "plugins": [names] }`)
    const missing = list.filter(name => !current.plugins.includes(name))
    // Written when names are missing, and when the file is: the page needs one even if empty.
    if (missing.length || !existsSync(json)) await put('plugins.json', Buffer.from(`${JSON.stringify({ ...current, plugins: [...current.plugins, ...missing] }, null, 2)}\n`))
    if (root) {
      // store.json is the app's (its seed, from a template), never the kit's.
      const top = (await files(root)).filter(file => file !== 'plugins.json' && file !== 'store.json' && !file.startsWith(`plugins${sep}`))
        .sort((a, b) => (a === 'index.html') - (b === 'index.html'))
      for (const file of top) await put(file, await readFile(join(root, file)))
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  return changed
}
