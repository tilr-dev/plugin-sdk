// `@tilr-dev/plugin/build`: the build every plugin repo shares. A plugin's build.mjs is
//
//   import { buildPlugin } from '@tilr-dev/plugin/build'
//   await buildPlugin()
//
// and `node build.mjs [--watch] [--install] [--site DIR]` (or `tilr-plugin build …`, which runs
// it, or this with the defaults when there is no build.mjs) builds src/index.ts(x) into dist/:
//
// - bundle (default): esbuild bundles the entry and what it imports into dist/index.js, with
//   the page's import map (IMPORT_MAP: 'tilr', 'tilr/*', 'cordis', 'react', …) left as bare
//   imports, so the plugin shares the running core's copies. Linked sourcemap.
// - bundle: false: the entry alone, its types stripped (esbuild.transform), imports untouched,
//   inline sourcemap: what the template did. An import the page cannot resolve (anything outside
//   the import map, a relative file) fails the build, naming the file and the specifier, instead
//   of an install that 404s.
// - Both: platform browser, ESM, safari17, `__TILR_VERSION__` = package.json's version,
//   `__TILR_API__` = the plugin API version of the installed @tilr-dev/plugin (its package.json
//   `tilrApi`, the API its api/ types describe; the package version for an SDK without one), and
//   a stamp appended to index.js (`export const __tilrBuild = { version, api: '^' + api }`)
//   from which the runtime fills in the `version` and `api` a plugin leaves out.
// - src/api.ts (a service's types), if there is one, → dist/api.d.ts as is: what
//   `tilr.describe('<service>')` hands an agent. Assets (ASSETS) under src/ are copied to dist/
//   at the same relative path; `copy` adds files from elsewhere.
// - The build goes to a temp folder; dist/ is replaced only once every output is there, so a
//   failed build (or hook) leaves the last good dist/. What a build stopped midway left in the
//   cache is removed by the next one.
// - --install: after each good build, dist/ → plugins/<name>/ of the Tilr site (installPlugin,
//   @tilr-dev/plugin/install's rules: assets before index.js, plugins.json merged).
// - --watch: build, then rebuild on changes under src/ and to package.json, one build at a
//   time (changes during a build make one more, not one each), 30 ms after the last change; a
//   failed build or install is logged and the watch goes on.
//
// `esbuild` adds options (a function of the build gets them per build: an editor's lazy outputs);
// `hooks.after` runs after the main build, before the swap, with the temp folder as `out`, for
// outputs of a plugin's own (workers, wasm, grammars). Node only. The types: build-plugin.d.mts.
import * as esbuild from 'esbuild'
import { existsSync, readFileSync, watch } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSite, pluginName, siteDir } from './install-site.js'

const KIT = fileURLToPath(new URL('..', import.meta.url))
const KIT_PACKAGE = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8'))

/** The bare names the page's import map resolves (static/index.html): left as imports, never
 *  bundled. tools/build-plugin.test.mjs checks this against the import map. */
export const IMPORT_MAP = [
  'cordis',
  '@deepseek-ai/cosmokit',
  'tilr',
  'tilr/react',
  'tilr/ui',
  'tilr/native',
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]
/** What src/ may hold besides sources, copied to dist/; the core's build allows the same. */
export const ASSETS = ['.css', '.json', '.svg', '.png', '.jpg', '.webp', '.woff2', '.txt', '.md']
/** The export appended to index.js; the runtime reads it (src/lib.ts, stampBuild). */
export const STAMP = '__tilrBuild'

const TSCONFIG_RAW = {
  // tsconfig has verbatimModuleSyntax for tsc; here an import that only names types must be
  // dropped, or the browser rejects the module. Class fields: what the core's build does.
  compilerOptions: { verbatimModuleSyntax: false, useDefineForClassFields: true },
}

/** Editor droppings: dotfiles, backups (index.ts~), vim's 4913. */
const junk = name => name.startsWith('.') || name.endsWith('~') || /^\d+$/.test(name)
/** Never sources or assets, should the entry's folder be the repo itself: the dependencies and
 *  the build's own output (which a watch would otherwise rebuild on forever). */
const generated = path => /^(node_modules|dist)(\/|$)/.test(path.split(sep).join('/'))
/** major.minor.patch: the parts checkNode() compares. */
const SEMVER_PARTS = 3
/** The build log names this many files besides index.js, then "… N more". */
const MAX_LOGGED_FILES = 12
const BYTES_PER_KIB = 1024
/** --watch waits this long after the last change: an editor's save is several events. */
const WATCH_DEBOUNCE_MS = 30

/** Throws a readable error unless `version` (default: this Node) meets package.json's
 *  `engines.node` (`>=22.18`: type stripping for node --test, recursive fs.watch). */
export function checkNode(version = process.versions.node, range = KIT_PACKAGE.engines?.node ?? '>=22.18') {
  const min = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim())
  if (!min) return
  const have = version.replace(/^v/, '').split('.').map(Number)
  const want = min.slice(1).map(n => Number(n ?? 0))
  for (let i = 0; i < SEMVER_PARTS; i++) {
    if ((have[i] ?? 0) > want[i]) return
    if ((have[i] ?? 0) < want[i]) {
      throw new Error(
        `@tilr-dev/plugin needs Node ${range}; ${process.execPath} is v${version}. Install a newer Node (nvm install 22, brew install node) and run again.`,
      )
    }
  }
}

/** The plugin API version a @tilr-dev/plugin package.json declares: `tilrApi`, else (an SDK from
 *  before the two were separate) its package version. */
const tilrApi = pkg => pkg.tilrApi ?? pkg.version

/** The plugin API version the plugin at `root` builds against: its installed @tilr-dev/plugin's,
 *  else this package's own. */
export function apiVersion(root = process.cwd()) {
  try {
    const require = createRequire(join(resolve(root), 'package.json'))
    return tilrApi(JSON.parse(readFileSync(require.resolve('@tilr-dev/plugin/package.json'), 'utf8')))
  } catch {
    return tilrApi(KIT_PACKAGE)
  }
}

/** The entry: `entry`, else src/index.tsx, else src/index.ts. */
function entryOf(root, entry) {
  if (entry) {
    if (!existsSync(join(root, entry))) throw new Error(`entry ${entry} does not exist`)
    // './src/index.ts' is 'src/index.ts': the paths it is compared with are normalized.
    return normalize(entry)
  }
  for (const candidate of ['src/index.tsx', 'src/index.ts']) if (existsSync(join(root, candidate))) return candidate
  throw new Error('no src/index.ts or src/index.tsx (or pass `entry`)')
}

/** The service's types: `api`, else src/api.ts when it exists; false for none. */
function apiOf(root, api) {
  if (api === false) return null
  if (api) {
    if (!existsSync(join(root, api))) throw new Error(`api ${api} does not exist`)
    return normalize(api)
  }
  return existsSync(join(root, 'src/api.ts')) ? 'src/api.ts' : null
}

/** Files under `dir`, relative to it, junk left out. */
async function files(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true })
  } catch {
    return out
  }
  for (const d of entries) {
    if (!d.isFile() || junk(d.name)) continue
    const path = relative(dir, join(d.parentPath, d.name))
    if (path.split(sep).some(junk)) continue
    out.push(path)
  }
  return out.sort()
}

/** `code` with the build stamp appended, before a trailing sourceMappingURL comment (the map
 *  stays valid: nothing mapped moves). Throws if the code has a `__tilrBuild` of its own: a second
 *  export of the name would be a SyntaxError in the page. */
export function stamp(code, { version, api }) {
  if (new RegExp(`\\b${STAMP}\\b`).test(code)) {
    throw new Error(
      `dist/index.js has a ${STAMP} of its own: the build appends that export (version and api); remove it from the source`,
    )
  }
  const line = `export const ${STAMP} = ${JSON.stringify({ version, api: `^${api}` })};\n`
  const at = code.lastIndexOf('\n//# sourceMappingURL=')
  if (at === -1) return `${code}${code.endsWith('\n') || code === '' ? '' : '\n'}${line}`
  return `${code.slice(0, at + 1)}${line}${code.slice(at + 1)}`
}

/** esbuild messages, printed the way esbuild prints them. */
async function report(messages, kind) {
  if (!messages.length) return
  const text = await esbuild.formatMessages(messages, { kind, color: process.stderr.isTTY })
  ;(kind === 'error' ? console.error : console.warn)(text.join(''))
}

/** What an esbuild failure says, as messages. */
function messagesOf(error) {
  return error?.errors?.length ? error.errors : [{ text: error instanceof Error ? error.message : String(error) }]
}

/** The `esbuild` option, resolved for this build. */
async function extraOptions(extra, context) {
  if (typeof extra === 'function') return (await extra(context)) ?? {}
  return extra ?? {}
}

/** Merges the shared options with a plugin's: `define`, `loader` and `alias` merge key by key,
 *  `plugins` append, everything else (external, minify, entryPoints, sourcemap…) replaces. */
function merge(base, extra) {
  const out = { ...base, ...extra }
  for (const key of ['define', 'loader', 'alias'])
    if (base[key] || extra[key]) out[key] = { ...base[key], ...extra[key] }
  out.plugins = [...(base.plugins ?? []), ...(extra.plugins ?? [])]
  return out
}

/** The options esbuild.transform takes (bundle: false). */
const TRANSFORM_KEYS = new Set([
  'define',
  'target',
  'minify',
  'minifyWhitespace',
  'minifyIdentifiers',
  'minifySyntax',
  'banner',
  'footer',
  'jsx',
  'jsxFactory',
  'jsxFragment',
  'jsxImportSource',
  'jsxDev',
  'supported',
  'charset',
  'drop',
  'dropLabels',
  'pure',
  'keepNames',
  'legalComments',
  'sourcemap',
  'sourcesContent',
  'platform',
  'format',
  'treeShaking',
  'ignoreAnnotations',
  'mangleProps',
  'reserveProps',
])

/** bundle: false. Checks that every import of the entry resolves in the page (one esbuild pass
 *  that resolves nothing: an import-map name is external, anything else is an error), then
 *  strips the types of the entry alone. Resolves to dist path → bytes. */
async function transformEntry({ root, entry, define, extra }) {
  for (const key of Object.keys(extra)) {
    if (!TRANSFORM_KEYS.has(key))
      throw new Error(
        `esbuild.${key}: not an option of a bundle: false build (esbuild.transform); bundle the plugin to use it`,
      )
  }
  const file = join(root, entry)
  const loader = entry.endsWith('.tsx') ? 'tsx' : 'ts'
  const guard = {
    name: 'tilr-import-map',
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return undefined
        if (IMPORT_MAP.includes(args.path)) return { path: args.path, external: true }
        const where = relative(root, args.importer) || entry
        const why =
          args.path.startsWith('.') || args.path.startsWith('/')
            ? 'with bundle: false the plugin is this one file, and the page would 404 on another'
            : `only the page's import map resolves a bare name (${IMPORT_MAP.join(', ')})`
        return {
          errors: [
            { text: `${where} imports '${args.path}': ${why}. Bundle the plugin (bundle: true) or drop the import.` },
          ],
        }
      })
    },
  }
  await esbuild.build({
    entryPoints: [file],
    bundle: true,
    write: false,
    logLevel: 'silent',
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    target: 'safari17',
    define,
    tsconfigRaw: TSCONFIG_RAW,
    plugins: [guard],
    outdir: join(root, 'dist'),
  })
  const { code } = await esbuild.transform(await readFile(file, 'utf8'), {
    loader,
    jsx: 'automatic',
    format: 'esm',
    target: 'safari17',
    sourcemap: 'inline',
    charset: 'utf8',
    sourcefile: relative(join(root, 'dist'), file),
    tsconfigRaw: TSCONFIG_RAW,
    ...extra,
    define: { ...define, ...extra.define },
  })
  return new Map([['index.js', Buffer.from(code)]])
}

/** bundle: true. Resolves to dist path → bytes, and esbuild's result. */
async function bundleEntry({ root, entry, define, extra }) {
  const dist = join(root, 'dist')
  const options = merge(
    {
      // Relative to absWorkingDir, as a plugin's own build.mjs had it (esbuild names the default
      // export after the path: `index_default`).
      entryPoints: [entry],
      bundle: true,
      external: IMPORT_MAP,
      platform: 'browser',
      format: 'esm',
      target: 'safari17',
      jsx: 'automatic',
      // Linked, not inline: the bundle's sources would make an inline map several times the code.
      sourcemap: 'linked',
      // Paths in the map are relative to dist/, where the files end up (written to a temp folder).
      outdir: dist,
      charset: 'utf8',
      write: false,
      logLevel: 'silent',
      absWorkingDir: root,
      define,
      tsconfigRaw: TSCONFIG_RAW,
    },
    extra,
  )
  options.write = false
  const result = await esbuild.build(options)
  await report(result.warnings, 'warning')
  const out = new Map()
  for (const file of result.outputFiles) {
    const path = relative(dist, file.path)
    if (path.startsWith('..'))
      throw new Error(`esbuild wrote ${file.path}, outside dist/: keep outdir / outfile in dist/`)
    out.set(path, Buffer.from(file.contents))
  }
  return { out, result }
}

/** Whether `path` is there, a dangling symlink included. */
const present = path =>
  lstat(path).then(
    () => true,
    () => false,
  )

/** True while process `pid` runs (EPERM: it does, as another user's). */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Removes what a build stopped midway (Ctrl-C, a crash) left in the cache: the temp folders of
 *  processes that are gone. A running process's (a concurrent build) are left alone. */
async function sweep(cache) {
  let names
  try {
    names = await readdir(cache)
  } catch {
    return
  }
  for (const name of names) {
    const pid = Number(/^(?:out|old)-(\d+)-/.exec(name)?.[1])
    if (!pid || pid === process.pid || alive(pid)) continue
    await rm(join(cache, name), { recursive: true, force: true })
  }
}

/** Moves `from` to `to`, across file systems too. */
async function move(from, to) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

/** One build of the plugin at `root` into a temp folder, swapped into dist/ when complete.
 *  Resolves to the dist paths written, or null when it failed (dist/ untouched). */
// oxlint-disable-next-line complexity -- the build sequence (bundle or transform, api.d.ts, assets, copy, hooks, atomic swap) kept in one place so the swap is visibly last
async function buildOnce(options, root, state) {
  const started = Date.now()
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = pkg.version ?? '0.0.0'
  const api = apiVersion(root)
  const cache = existsSync(join(root, 'node_modules'))
    ? join(root, 'node_modules', '.cache', 'tilr-plugin-build')
    : join(root, '.tilr-build')
  await mkdir(cache, { recursive: true })
  await sweep(cache)
  // The pid: sweep() tells a dead build's folder from a running one's. mkdtemp's folder is 0700;
  // dist/ is made inside it with mkdir, so it gets the umask's mode like any other folder.
  const tmp = await mkdtemp(join(cache, `out-${process.pid}-`))
  const out = join(tmp, 'dist')
  await mkdir(out)
  const dist = join(root, 'dist')
  try {
    const entry = entryOf(root, options.entry)
    const apiFile = apiOf(root, options.api)
    const bundle = options.bundle !== false
    const context = {
      root,
      out,
      dist,
      version,
      api,
      name: pluginName(pkg),
      entry,
      bundle,
      watching: state.watching,
      argv: state.argv,
    }
    const extra = await extraOptions(options.esbuild, context)
    const define = { __TILR_VERSION__: JSON.stringify(version), __TILR_API__: JSON.stringify(api), ...options.define }
    let outputs
    let result = null
    try {
      if (bundle) ({ out: outputs, result } = await bundleEntry({ root, entry, define, extra }))
      else outputs = await transformEntry({ root, entry, define, extra })
    } catch (error) {
      await report(messagesOf(error), 'error')
      return null
    }
    if (!outputs.has('index.js'))
      throw new Error(
        `no dist/index.js among the outputs (${[...outputs.keys()].join(', ')}): the entry must be named index`,
      )
    outputs.set('index.js', Buffer.from(stamp(outputs.get('index.js').toString('utf8'), { version, api })))
    if (apiFile) outputs.set('api.d.ts', await readFile(join(root, apiFile)))

    const src = join(root, dirname(entry))
    const assets = new Set(options.assets ?? ASSETS)
    for (const path of await files(src)) {
      if (src === root && generated(path)) continue
      const ext = extname(path)
      if (/\.test(-d)?\.tsx?$/.test(path) || /\.d\.ts$/.test(path)) continue
      if (/^\.tsx?$/.test(ext)) {
        if (!bundle && join(dirname(entry), path) !== entry && join(dirname(entry), path) !== apiFile) {
          warn(
            state,
            `skipped ${join(dirname(entry), path)}: with bundle: false only ${entry} is compiled (a plugin is one file)`,
          )
        }
        continue
      }
      if (!assets.has(ext)) continue
      if (outputs.has(path)) throw new Error(`${join(dirname(entry), path)} collides with the build's dist/${path}`)
      outputs.set(path, await readFile(join(src, path)))
    }
    for (const [path, from] of Object.entries(options.copy ?? {})) {
      if (outputs.has(path)) throw new Error(`copy: dist/${path} is an output of the build already`)
      outputs.set(path, await readFile(resolve(root, from)))
    }
    for (const [path, data] of outputs) {
      await mkdir(dirname(join(out, path)), { recursive: true })
      await writeFile(join(out, path), data)
    }
    if (options.hooks?.after) await options.hooks.after({ ...context, result, files: [...outputs.keys()] })

    // Every output is there: dist/ is replaced at once (two renames on one file system). The
    // last good dist/ goes into the temp folder (removed below with it), and back if the second
    // rename fails. A symlink at dist/ is moved aside the same way: dist/ becomes a folder.
    const old = (await present(dist)) ? join(tmp, 'old') : null
    if (old) await move(dist, old)
    try {
      await move(out, dist)
    } catch (error) {
      if (old && !(await present(dist))) await move(old, dist)
      throw error
    }
    const written = await files(dist)
    const index = outputs.get('index.js')
    const rest = written.filter(path => path !== 'index.js' && !path.endsWith('.map'))
    const shown =
      rest.length > MAX_LOGGED_FILES
        ? [...rest.slice(0, MAX_LOGGED_FILES), `… ${rest.length - MAX_LOGGED_FILES} more`]
        : rest
    console.log(
      `[build] ${Date.now() - started}ms: dist/index.js (${Math.round(index.length / BYTES_PER_KIB)}K)${shown.map(path => ` dist/${path}`).join('')} (version ${version}, api ^${api})`,
    )
    return written
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Warns once per message (a watch would repeat it on every build). */
function warn(state, message) {
  if (state.warned.has(message)) return
  state.warned.add(message)
  console.warn(`[build] ${message}`)
}

/**
 * Installs the plugin at `root` (its dist/) into the Tilr site: --site DIR, $TILR_SITE, the
 * app's config, the default (@tilr-dev/plugin/install). Refuses a site without the core page.
 * Resolves to the changed site paths.
 */
export async function installPlugin({ root = process.cwd(), argv = process.argv.slice(2) } = {}) {
  const site = siteDir(argv)
  if (!existsSync(join(site, 'index.html')))
    throw new Error(`${site} has no Tilr page yet: run npm run install:site in the core repo first`)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const name = pluginName(pkg)
  const changed = await installSite({ site, plugins: { [name]: join(root, 'dist') } })
  console.log(`[install] ${site}: ${changed.length ? changed.join(' ') : 'no change'}`)
  return changed
}

/** Builds the plugin (see the header). */
export async function buildPlugin(options = {}) {
  checkNode()
  const root = resolve(options.root ?? process.cwd())
  const argv = options.argv ?? process.argv.slice(2)
  const watching = argv.includes('--watch')
  const installing = argv.includes('--install')
  const state = { watching, argv, warned: new Set() }
  const once = async () => {
    try {
      return await buildOnce(options, root, state)
    } catch (error) {
      console.error(`[build] ${error.message}`)
      return null
    }
  }

  if (!watching) {
    const files = await once()
    if (!files) {
      process.exitCode = 1
      return { ok: false, files: [], close() {} }
    }
    if (installing) {
      try {
        await installPlugin({ root, argv })
      } catch (error) {
        console.error(`[install] ${error.message}`)
        process.exitCode = 1
        return { ok: false, files, close() {} }
      }
    }
    return { ok: true, files, close() {} }
  }

  // One build at a time, 30 ms after the last change of a burst (editors write twice), and at
  // most one waiting: the build that waits for the running one reads every change made so far.
  let last = { ok: false, files: [] }
  let closed = false
  let queued = false
  const run = async () => {
    const files = await once()
    last = { ok: !!files, files: files ?? [] }
    if (!files || !installing) return
    try {
      await installPlugin({ root, argv })
    } catch (error) {
      console.error(`[install] ${error.message}`)
    }
  }
  let running = run()
  await running
  let timer = null
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (closed || queued) return
      queued = true
      running = running.then(() => {
        queued = false
        return closed ? undefined : run()
      })
    }, WATCH_DEBOUNCE_MS)
  }
  const src = join(root, dirname(entryOf(root, options.entry)))
  const ignored = file => file.split(sep).some(junk) || (src === root && generated(file))
  const watchers = [
    // fs.watch is recursive on macOS (and Linux since Node 20).
    watch(src, { recursive: true }, (event, file) => {
      if (!file || !ignored(file)) schedule()
    }),
    // The folder, not the file: an editor saves package.json by replacing it.
    watch(root, (event, file) => {
      if (file === 'package.json') schedule()
    }),
  ]
  for (const watcher of watchers) watcher.on('error', error => console.error(`[build] watching: ${error.message}`))
  console.log(
    `[build] watching ${relative(root, src) || '.'}/ and package.json → dist/${installing ? ' → the Tilr site' : ''}`,
  )
  return {
    get ok() {
      return last.ok
    },
    get files() {
      return last.files
    },
    close() {
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}
