#!/usr/bin/env node
// `tilr`: an app is a workspace folder the Tilr shell shows. Shipped as the `tilr` bin of
// @tilr-dev/plugin (`npm link` in the core repo puts it on PATH until the package is published).
//
//   tilr app new DIR [--name NAME] [--from TEMPLATE]
//                                      a new app: tilr.json, a git repo, the core page in site/; --from:
//                                      a template's plugins (copies of its clones, built here) and store
//   tilr app export DIR [--window NAME] [--no-store] [--socket PATH]
//                                      the app as a template folder: tilr.json, a copy of each clone (.git
//                                      kept, no node_modules / dist), the running window's store (store.json;
//                                      the window is tilr.json's name unless --window); nothing from the network
//   tilr plugin add SRC... [--ref R]   SRC is a core plugin's name (theme, panel …) or a git URL /
//                                      path: cloned shallow into plugins/<name>/, built, installed
//   tilr plugin update [NAME...]       fetch upstream, merge into the clone, rebuild, reinstall
//   tilr plugin build [NAME...]        rebuild the clone(s) and reinstall into site/
//   tilr plugin remove NAME            drop from the app and site/; the clone stays in plugins/
//   tilr plugin status [--fetch]       clean / modified / forked (+N) / behind (-M, with --fetch)
//   tilr build                         the core page and every plugin into site/
//   tilr dev NAME                      the clone's own watcher, installing into this app's site/
//   Every command above takes --app DIR; without it the app is the nearest tilr.json upwards.
//
//   tilr ctl apps | switch APP | reload | snapshot PATH | console [--clear] | eval JS |
//            call SERVICE[.METHOD] [ARG...] | call 'EXPR' | plugins | toggle NAME | reload-plugin NAME |
//            windows | types | open TYPE [CONFIG] [--float] | close ID | float ID [RECT] | tile ID | focus ID |
//            ui [--window W] [--lines N] [--json] | act REF ACTION [VALUE] [--wait [REGEX]] | api [SERVICE] |
//            debug status | on | off | record [N] [--path P] | metrics [--filter PREFIX] [--json] |
//                  bench [all|typing|throughput|idle] [--seconds N] [--size N] [--out FILE] [--window W] [--json] |
//                  compare A.json B.json [--threshold PCT] |
//                  memory [--seconds N] [--interval S] [--no-squeeze] [--out FILE] [--json] |
//                  footprint [--json] | squeeze | inspect
//                                      drives the running shell through Tilr Control (its socket; ARGs are
//                                      JSON, a bare word is a string; in JS and EXPR `$` is the running
//                                      services: `$.server.get("local").connect()`). --app NAME picks the window.
//                                      debug: the app's debug mode (page perf collector on/off, reloads the
//                                      page); record N seconds of it (default 5) to a JSON file, print a summary;
//                                      metrics: the page's metric() series (count, rate/s, p50/p95/max of 10 s);
//                                      bench: terminal scenarios in a fresh terminal window (or W), to a JSON file;
//                                      compare: two bench files, exit 1 on a regression beyond PCT (10);
//                                      memory: probe memory, listeners, DOM nodes every S (5) s for N (120)
//                                      s, squeezing WebKit after the first probe and at the end: per process a
//                                      verdict (leak or not), memory by category, hints where, to a JSON file;
//                                      footprint: memory by category per process (malloc, graphics, js, jit,
//                                      other); squeeze: ask WebKit to release memory (before → after);
//                                      inspect: open Safari Web Inspector for the page
//   tilr mcp                           the same, as an MCP server on stdio: `claude mcp add tilr -- tilr mcp`
//   tilr edit PATH | open [--kind K] TARGET [ARG...]
//                                      in a tilr-server pane (TILR_SOCK set): asks the client watching the
//                                      pane to open it, as the server's own `tilr` shim does (this one shadows it)
//
// The layout:
//   tilr.json         the app: name, kit (the core repo or package), plugins (name, source, ref,
//                     commit: what is installed)
//   plugins/<name>/   one git clone per plugin, depth 1: the latest upstream only. Editing it is
//                     forking it: commits land in the clone; `update` merges upstream into them.
//   site/             the build the shell shows (tilr://<app>/): the core page from the kit, each
//                     plugin's dist/ as plugins/<name>/, plugins.json in tilr.json's order
//   web -> kit        a symlink, so a clone's `"@tilr-dev/plugin": "file:../../web"` resolves,
//                     as in the monorepo; goes away when the package is on npm
// Node only, no dependencies: git and npm are run as commands.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installSite, pluginName } from './install-site.js'
import { corePlugins } from './paths.js'
import {
  act,
  call,
  control,
  controlSocket,
  debug,
  debugMetrics,
  debugText,
  describe,
  describeText,
  evaluate,
  metricRows,
  metricsText,
  plugins,
  resolveWindow,
  snapshot,
  windowId,
} from './control.mjs'
import { benchText, compareBench, compareText, runBench, SCENARIOS, writeBench } from './bench.mjs'
import {
  debugFootprint,
  debugInspect,
  debugSqueeze,
  footprintText,
  inspectText,
  memoryPath,
  memoryText,
  runMemory,
  squeezeText,
} from './memory.mjs'

const KIT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const MANIFEST = 'tilr.json'

const usage = () => {
  console.error(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(4, 40)
      .map(l => l.replace(/^\/\/ ?/, ''))
      .join('\n'),
  )
  process.exit(2)
}

const flag = (argv, name) => {
  const i = argv.indexOf(name)
  if (i === -1) return null
  const value = argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  argv.splice(i, 2)
  return value
}
const has = (argv, name) => {
  const i = argv.indexOf(name)
  if (i !== -1) argv.splice(i, 1)
  return i !== -1
}
const expand = path => path.replace(/^~(?=$|\/)/, homedir())

/** Runs a command, output shown; throws on a non-zero exit. */
const run = (cmd, args, cwd, { quiet = false } = {}) => {
  const r = spawnSync(cmd, args, { cwd, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}${quiet ? `: ${(r.stderr || r.stdout).trim()}` : ''}`)
  return (r.stdout ?? '').trim()
}
const git = (args, cwd) => run('git', args, cwd, { quiet: true })
/** `npm ci` when the clone has a lockfile (it stays untouched, so the clone stays clean), else
 *  `npm install`. */
const npmInstall = dir =>
  run('npm', [existsSync(join(dir, 'package-lock.json')) ? 'ci' : 'install', '--no-fund', '--no-audit'], dir)

/** Writes the file when its bytes differ (the shell watches site/). */
async function put(path, text) {
  try {
    if ((await readFile(path, 'utf8')) === text) return false
  } catch {}
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.tmp`)
  await writeFile(tmp, text)
  await rename(tmp, path)
  return true
}

// ---- the app ----------------------------------------------------------------------------------

class App {
  constructor(dir) {
    this.dir = dir
    this.manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'))
    if (!Array.isArray(this.manifest.plugins)) throw new Error(`${join(dir, MANIFEST)}: expected "plugins": [...]`)
    this.kit = resolve(dir, expand(this.manifest.kit ?? KIT))
    this.site = join(dir, 'site')
  }

  /** The app `--app DIR` names, else the nearest tilr.json from cwd upwards. */
  static find(argv) {
    const given = flag(argv, '--app')
    if (given) return new App(resolve(expand(given)))
    for (let dir = process.cwd(); ; dir = dirname(dir)) {
      if (existsSync(join(dir, MANIFEST))) return new App(dir)
      if (dirname(dir) === dir) throw new Error(`no ${MANIFEST} here or above; pass --app DIR or run tilr app new`)
    }
  }

  static async create(dir, { name, from = null }) {
    if (existsSync(join(dir, MANIFEST))) throw new Error(`${dir} is an app already`)
    await mkdir(dir, { recursive: true })
    if ((await readdir(dir)).length) throw new Error(`${dir} is not empty`)
    await writeFile(join(dir, MANIFEST), `${JSON.stringify({ name, kit: KIT, plugins: [] }, null, 2)}\n`)
    await writeFile(join(dir, '.gitignore'), 'plugins/\nsite/\nweb\n.DS_Store\n')
    await writeFile(
      join(dir, 'README.md'),
      `# ${name}\n\nA Tilr app: \`tilr.json\` lists its plugins, \`plugins/<name>/\` is a git clone of each (edit it and you have forked it; \`tilr plugin update\` merges upstream), \`site/\` is what the Tilr shell shows. Run \`tilr\` for the commands.\n`,
    )
    await symlink(KIT, join(dir, 'web'))
    git(['init', '-q'], dir)
    git(['add', '-A'], dir)
    git(
      ['-c', 'user.name=tilr', '-c', 'user.email=tilr@localhost', 'commit', '-q', '-m', `${name}: a new Tilr app`],
      dir,
    )
    const app = new App(dir)
    await app.installCore()
    await app.writePluginsJson()
    if (from) await app.adopt(from)
    console.log(`[tilr] ${dir}: new app '${name}'. Point the shell at ${app.site}`)
    if (from) console.log(`[tilr] for the Mac app's config.yml, under apps:\n  - name: ${name}\n    site: ${app.site}`)
    return app
  }

  /** A template's manifest (tilr.json without `kit`), checked against the folder (a clone for
   *  each plugin that is not core) and the kit (each core one is the kit's). */
  static template(dir, kit = KIT) {
    const file = join(dir, MANIFEST)
    if (!existsSync(file)) throw new Error(`${dir}: no ${MANIFEST}; not a template (tilr app export makes one)`)
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(manifest.plugins)) throw new Error(`${file}: expected "plugins": [...]`)
    const core = corePlugins(kit)
    for (const p of manifest.plugins) {
      if (p.source === 'core' && !core.includes(p.name))
        throw new Error(`${p.name}: a core plugin the kit (${kit}) does not have`)
      if (p.source !== 'core' && !existsSync(join(dir, 'plugins', p.name, '.git')))
        throw new Error(`${p.name}: the template has no clone of it (plugins/${p.name}/ with its .git)`)
    }
    return manifest
  }

  /** Fills a new app from a template folder: its clones copied into plugins/ (all first, a clone
   *  may depend on another's folder: file:../server), then each plugin in the template's order
   *  added (core) or built and installed (a clone), its store.json as the site's seed. */
  async adopt(from) {
    const manifest = App.template(from, this.kit)
    for (const p of manifest.plugins.filter(p => p.source !== 'core'))
      await cp(join(from, 'plugins', p.name), this.clone(p.name), {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      })
    for (const p of manifest.plugins) {
      let entry
      if (p.source === 'core') entry = await this.add(p.name, {})
      else {
        const dir = this.clone(p.name)
        entry = {
          name: p.name,
          source: p.source,
          ref: p.ref ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
          commit: git(['rev-parse', 'HEAD'], dir),
        }
        await this.build(entry)
        this.manifest.plugins.push(entry)
      }
      await this.save()
      console.log(
        `[tilr] + ${entry.name}${entry.source === 'core' ? ' (core)' : ` ← ${entry.source} @ ${entry.commit.slice(0, 7)} (from the template)`}`,
      )
    }
    if (existsSync(join(from, 'store.json'))) {
      await copyFile(join(from, 'store.json'), join(this.site, 'store.json'))
      console.log('[tilr] store.json → site/: the page seeds its store from it on its first load')
    }
    await this.writePluginsJson()
  }

  /** Writes the app as a template into `target` (absent or empty): tilr.json without `kit`, a
   *  copy of each clone (its .git and uncommitted changes included; node_modules and the build
   *  output left out), `store` (the running window's dump, or null: no store.json), a README. */
  async export(target, { store }) {
    if (existsSync(target) && (await readdir(target)).length) throw new Error(`${target} is not empty`)
    const inApp = real(target) === real(this.dir) || real(target).startsWith(real(this.dir) + sep)
    if (inApp) throw new Error(`${target} is inside the app; export somewhere else`)
    await mkdir(target, { recursive: true })
    const manifest = { ...this.manifest }
    delete manifest.kit
    await writeFile(join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    const vendored = []
    for (const entry of this.manifest.plugins) {
      if (entry.source === 'core') continue
      const dir = this.clone(entry.name)
      if (!existsSync(join(dir, '.git'))) throw new Error(`${entry.name}: no clone in plugins/${entry.name}/ to export`)
      let dist = 'dist'
      try {
        dist = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).tilr?.dist ?? 'dist'
      } catch {}
      const skip = resolve(dir, dist)
      await cp(dir, join(target, 'plugins', entry.name), {
        recursive: true,
        verbatimSymlinks: true,
        filter: path => basename(path) !== 'node_modules' && resolve(path) !== skip,
      })
      vendored.push(entry.name)
    }
    if (store) await writeFile(join(target, 'store.json'), `${JSON.stringify(store, null, 2)}\n`)
    await writeFile(join(target, 'README.md'), templateReadme(manifest, vendored, store !== null))
    return vendored
  }

  async save() {
    await put(join(this.dir, MANIFEST), `${JSON.stringify(this.manifest, null, 2)}\n`)
  }
  entry(name) {
    return this.manifest.plugins.find(p => p.name === name)
  }
  clone(name) {
    return join(this.dir, 'plugins', name)
  }
  kitSite() {
    const site = join(this.kit, 'site')
    if (!existsSync(join(site, 'index.html')))
      throw new Error(`${this.kit} has no built page (site/index.html): run npm run build there`)
    return site
  }
  coreNames() {
    return corePlugins(this.kit)
  }

  async installCore() {
    const changed = await installSite({ site: this.site, root: this.kitSite(), plugins: {}, list: [] })
    if (changed.length) console.log(`[tilr] core → site/: ${changed.join(' ')}`)
  }

  /** plugins.json: the plugins in tilr.json's order, and `store` when site/ has a store.json
   *  (the seed a fresh page's store starts from; a page is not asked for one it has not). */
  async writePluginsJson() {
    const names = this.manifest.plugins.map(p => p.name)
    const seed = existsSync(join(this.site, 'store.json')) ? { store: 'store.json' } : {}
    if (await put(join(this.site, 'plugins.json'), `${JSON.stringify({ plugins: names, ...seed }, null, 2)}\n`))
      console.log(`[tilr] plugins.json: ${names.join(' ') || '(empty)'}${seed.store ? ' (seed: store.json)' : ''}`)
  }

  /** Builds and installs one plugin: a core one is copied from the kit; a clone runs its own
   *  `npm install` (once) and `npm run build`, then dist/ goes to site/plugins/<name>/. */
  async build(entry) {
    let from
    if (entry.source === 'core') from = join(this.kitSite(), 'plugins', entry.name)
    else {
      const dir = this.clone(entry.name)
      if (!existsSync(join(dir, 'package.json'))) throw new Error(`${dir}: no clone; tilr plugin add ${entry.source}`)
      if (!existsSync(join(dir, 'node_modules'))) npmInstall(dir)
      run('npm', ['run', 'build'], dir)
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      from = join(dir, pkg.tilr?.dist ?? 'dist')
    }
    const changed = await installSite({ site: this.site, plugins: { [entry.name]: from }, list: [] })
    console.log(`[tilr] ${entry.name} → site/: ${changed.length ? changed.join(' ') : 'no change'}`)
  }

  /** Clones `source` (a git URL, or a local repo path) shallow into plugins/<name>/ and adds it. */
  async add(source, { ref }) {
    if (this.coreNames().includes(source)) {
      if (this.entry(source)) throw new Error(`${source} is in the app already`)
      const entry = { name: source, source: 'core' }
      await this.build(entry)
      this.manifest.plugins.push(entry)
      return entry
    }
    const url = existsSync(expand(source)) ? pathToFileURL(resolve(expand(source))).href : source
    const staging = join(this.dir, 'plugins', `.adding-${Date.now()}`)
    await mkdir(dirname(staging), { recursive: true })
    try {
      run('git', ['clone', '--quiet', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, staging], this.dir)
      const pkg = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
      const name = pluginName(pkg)
      if (this.entry(name)) throw new Error(`${name} is in the app already (plugins/${name}/)`)
      if (existsSync(this.clone(name))) throw new Error(`plugins/${name}/ exists; remove it or tilr plugin add it back`)
      await rename(staging, this.clone(name))
      const dir = this.clone(name)
      const entry = {
        name,
        source: url,
        ref: ref ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
        commit: git(['rev-parse', 'HEAD'], dir),
      }
      await this.build(entry)
      this.manifest.plugins.push(entry)
      return entry
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /** The clone's state against what it was cloned from. */
  status(entry, { fetch = false } = {}) {
    if (entry.source === 'core') return { state: 'core' }
    const dir = this.clone(entry.name)
    if (!existsSync(join(dir, '.git'))) return { state: 'missing' }
    const upstream = `origin/${entry.ref}`
    if (fetch) git(['fetch', '--quiet', 'origin', entry.ref], dir)
    const dirty = git(['status', '--porcelain'], dir) !== ''
    const ahead = Number(git(['rev-list', '--count', `${upstream}..HEAD`], dir))
    const behind = Number(git(['rev-list', '--count', `HEAD..${upstream}`], dir))
    const state = dirty ? 'modified' : ahead ? 'forked' : 'clean'
    return { state, dirty, ahead, behind, head: git(['rev-parse', '--short', 'HEAD'], dir) }
  }

  /** Fetches upstream and merges it into the clone (fast-forward when nothing is local). */
  async update(entry) {
    if (entry.source === 'core') {
      await this.build(entry)
      return 'core'
    }
    const dir = this.clone(entry.name)
    const s = this.status(entry, { fetch: true })
    if (s.dirty)
      throw new Error(`${entry.name}: uncommitted changes in plugins/${entry.name}/; commit or stash them first`)
    if (!s.behind) {
      console.log(`[tilr] ${entry.name}: up to date${s.ahead ? ` (forked, +${s.ahead})` : ''}`)
      return 'same'
    }
    const r = spawnSync('git', ['merge', '--quiet', '--no-edit', `origin/${entry.ref}`], { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0)
      throw new Error(
        `${entry.name}: merge of origin/${entry.ref} has conflicts in plugins/${entry.name}/; resolve and commit, then tilr plugin build ${entry.name}\n${(r.stdout + r.stderr).trim()}`,
      )
    entry.commit = git(['rev-parse', 'HEAD'], dir)
    console.log(
      `[tilr] ${entry.name}: merged origin/${entry.ref} (-${s.behind}${s.ahead ? `, forked +${s.ahead}` : ''})`,
    )
    await this.build(entry)
    return 'merged'
  }

  async remove(name) {
    const i = this.manifest.plugins.findIndex(p => p.name === name)
    if (i === -1) throw new Error(`${name} is not in the app`)
    const [entry] = this.manifest.plugins.splice(i, 1)
    await this.writePluginsJson()
    await rm(join(this.site, 'plugins', name), { recursive: true, force: true })
    console.log(
      `[tilr] ${name}: removed from the app${entry.source !== 'core' && existsSync(this.clone(name)) ? `; plugins/${name}/ is kept` : ''}`,
    )
  }

  /** Which entries NAMES pick; all of them when empty. */
  pick(names) {
    if (!names.length) return this.manifest.plugins
    return names.map(
      name =>
        this.entry(name) ??
        (() => {
          throw new Error(`${name} is not in the app`)
        })(),
    )
  }
}

const real = path => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function templateReadme(manifest, vendored, store) {
  const name = manifest.name ?? 'app'
  return `# ${name}: a Tilr app template

Made by \`tilr app export\`. Everything to make the app again on a machine with the Tilr kit, nothing
fetched from the network:

- \`tilr.json\`: the app's plugins in order (\`source: "core"\` is the kit's; the rest name the git
  source each was cloned from).
- \`plugins/<name>/\`: a copy of each cloned plugin with its \`.git\` (its origin and any local
  commits or uncommitted edits), without \`node_modules\` or the build output: ${vendored.length ? vendored.join(', ') : 'none'}.
${
  store
    ? `- \`store.json\`: the app's store (every area, secure ones included): what the page starts with.
`
    : ''
}
Make an app from it:

\`\`\`sh
tilr app new DIR --from ${'<this folder>'} [--name NAME]
\`\`\`

The folder holds nested \`.git\` folders: copy or archive it whole, it is not a git repository.
`
}

// ---- tilr edit / tilr open, in a pane ----------------------------------------------------------

/** `tilr edit PATH`, `tilr open [--kind K] TARGET [ARG...]` inside a tilr-server pane: what the
 *  server's `tilr` shim does (core: crates/tilr-server/src/host.rs), which this bin shadows on the
 *  PATH. One JSON line to `$TILR_SOCK`, `{ pane_id, name: 'open', kind, path, args }`; the server
 *  answers `{ ok, clients?, error? }`. A file path is made absolute from the cwd; kind 'url' for
 *  a TARGET with a scheme (`https://…`), 'file' otherwise. */
async function hostEvent(command, argv) {
  const kindFlag = command === 'open' ? flag(argv, '--kind') : undefined
  const [target, ...args] = argv
  if (!target) throw new Error(command === 'edit' ? 'tilr edit PATH' : 'tilr open [--kind K] TARGET [ARG...]')
  const kind = command === 'edit' ? 'file' : (kindFlag ?? (/^[A-Za-z0-9+.-]+:\/\//.test(target) ? 'url' : 'file'))
  const paneId = process.env.TILR_PANE
  if (!paneId) throw new Error('not inside a tilr pane')
  const request = {
    pane_id: paneId,
    name: 'open',
    kind,
    path: kind === 'file' ? resolve(target) : target,
    args: command === 'edit' ? [] : args,
  }
  const reply = await new Promise((done, fail) => {
    const socket = createConnection(process.env.TILR_SOCK)
    let answer = ''
    socket.setTimeout(10_000, () => {
      socket.destroy()
      fail(new Error('the tilr server did not answer'))
    })
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => {
      answer += chunk
      const end = answer.indexOf('\n')
      if (end === -1) return
      socket.end()
      try {
        done(JSON.parse(answer.slice(0, end)))
      } catch {
        fail(new Error(`bad answer: ${answer.slice(0, end)}`))
      }
    })
    socket.on('error', error => fail(new Error(`cannot reach the tilr server: ${error.message}`)))
  })
  if (!reply.ok) throw new Error(reply.error ?? 'refused')
}

// ---- commands ---------------------------------------------------------------------------------

// eslint-disable-next-line complexity -- the CLI command dispatch: one case per `tilr` subcommand
async function main(argv) {
  const [group, verb, ...rest] = argv
  if ((group === 'edit' || group === 'open') && process.env.TILR_SOCK) return hostEvent(group, argv.slice(1))
  if (group === 'app' && verb === 'new') {
    const name = flag(rest, '--name')
    const fromFlag = flag(rest, '--from')
    const [dir] = rest
    if (!dir) usage()
    const target = resolve(expand(dir))
    const from = fromFlag ? resolve(expand(fromFlag)) : null
    const named = name ?? (from ? App.template(from).name : undefined) ?? basename(target)
    await App.create(target, { name: named, from })
    return
  }
  if (group === 'app' && verb === 'export') {
    const window = flag(rest, '--window')
    const noStore = has(rest, '--no-store')
    const socket = controlSocket(rest)
    const app = App.find(rest)
    const [dir] = rest
    if (!dir) usage()
    const target = resolve(expand(dir))
    if (existsSync(target) && (await readdir(target)).length) throw new Error(`${target} is not empty`)
    const store = noStore ? null : await storeOf(app, window, socket)
    const vendored = await app.export(target, { store })
    const keys = store ? Object.values(store).reduce((n, area) => n + Object.keys(area).length, 0) : 0
    console.log(`[tilr] ${target}: template of '${app.manifest.name}'`)
    console.log(
      `  plugins: ${app.manifest.plugins.length} (${vendored.length} vendored${vendored.length ? `: ${vendored.join(', ')}` : ''})`,
    )
    console.log(`  store: ${store ? `${Object.keys(store).length} areas, ${keys} keys` : 'not exported (--no-store)'}`)
    return
  }
  if (group === 'build' && (!verb || verb.startsWith('--'))) {
    const app = App.find([verb, ...rest].filter(Boolean))
    await app.installCore()
    for (const entry of app.manifest.plugins) await app.build(entry)
    await app.writePluginsJson()
    return
  }
  if (group === 'dev') {
    const args = [verb, ...rest].filter(Boolean)
    const app = App.find(args)
    const [name] = args
    const entry = name && app.entry(name)
    if (!entry || entry.source === 'core')
      throw new Error(
        `tilr dev NAME: a plugin cloned into this app (${
          app.manifest.plugins
            .filter(p => p.source !== 'core')
            .map(p => p.name)
            .join(', ') || 'none yet'
        })`,
      )
    const dir = app.clone(name)
    if (!existsSync(join(dir, 'node_modules'))) npmInstall(dir)
    run('npm', ['run', 'dev:site', '--', '--site', app.site], dir)
    return
  }
  if (group === 'mcp') {
    await import('./tilr-mcp.mjs')
    return
  }
  // Flags may come before the verb too: `tilr ctl --socket PATH apps`.
  if (group === 'ctl') return verb?.startsWith('--') ? ctlFlagsFirst(argv.slice(1)) : ctl(verb, rest)
  if (group !== 'plugin') usage()
  const app = App.find(rest)
  switch (verb) {
    case 'add': {
      const ref = flag(rest, '--ref')
      if (!rest.length) usage()
      for (const source of rest) {
        const entry = await app.add(source, { ref })
        await app.save()
        await app.writePluginsJson()
        console.log(
          `[tilr] + ${entry.name}${entry.source === 'core' ? ' (core)' : ` ← ${entry.source} @ ${entry.commit.slice(0, 7)}`}`,
        )
      }
      return
    }
    case 'update': {
      for (const entry of app.pick(rest)) await app.update(entry)
      await app.save()
      return
    }
    case 'build': {
      for (const entry of app.pick(rest)) await app.build(entry)
      await app.writePluginsJson()
      return
    }
    case 'remove': {
      if (rest.length !== 1) usage()
      await app.remove(rest[0])
      await app.save()
      return
    }
    case 'status': {
      const fetch = has(rest, '--fetch')
      for (const entry of app.pick(rest)) {
        const s = app.status(entry, { fetch })
        const marks = [s.ahead ? `+${s.ahead}` : '', s.behind ? `-${s.behind}` : ''].filter(Boolean).join(' ')
        console.log(
          `${entry.name.padEnd(12)} ${s.state.padEnd(9)} ${s.head ?? ''} ${marks}${entry.source === 'core' ? '' : `  ${entry.source}`}`,
        )
      }
      return
    }
    default:
      usage()
  }
}

/** The store of the running window that shows `app` (`window`, else the app's name), through
 *  Tilr Control: `store.dump()`. */
async function storeOf(app, window, socket) {
  const name = window ?? app.manifest.name
  const hint = `pass --window NAME (tilr ctl apps lists them), or --no-store to export without the store`
  if (!name) throw new Error(`tilr.json has no name to find the app's window by; ${hint}`)
  let apps
  try {
    ;({ apps } = await control({ cmd: 'apps' }, { socket }))
  } catch (error) {
    throw new Error(`cannot read the store of window '${name}': ${error.message}; ${hint}`, { cause: error })
  }
  const row = apps.find(a => a.name === name)
  if (!row)
    throw new Error(
      `no window '${name}' in the running Tilr (it has: ${apps.map(a => a.name).join(', ') || 'none'}); ${hint}`,
    )
  if (row.site && real(row.site) !== real(app.site)) {
    const message = `window '${name}' shows ${row.site}, not this app's ${app.site}`
    if (!window) throw new Error(`${message}; ${hint}`)
    console.warn(`[tilr] ${message}: exporting its store as asked`)
  }
  try {
    return await call('store', 'dump', [], { socket, app: name })
  } catch (error) {
    throw new Error(`cannot read the store of window '${name}': ${error.message}; ${hint}`, { cause: error })
  }
}

/** `tilr ctl --socket PATH --app NAME VERB …`: the flags taken out first, then the verb. */
function ctlFlagsFirst(argv) {
  const socket = flag(argv, '--socket')
  const app = flag(argv, '--app')
  const [verb, ...rest] = argv
  if (socket != null) rest.push('--socket', socket)
  if (app != null) rest.push('--app', app)
  return ctl(verb, rest)
}

/** `tilr ctl`: the running shell, through its control socket. Results are printed as JSON. */
// eslint-disable-next-line complexity -- the `tilr ctl` verb dispatch: one case per control verb
async function ctl(verb, rest) {
  const socket = controlSocket(rest)
  const app = flag(rest, '--app') ?? undefined
  const options = { socket, ...(app ? { app } : {}) }
  const shell = request => control({ ...request, ...(app ? { app } : {}) }, { socket })
  /** A JSON argument, or the bare word as a string. */
  const json = text => {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  const print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  const need = (n, what) => {
    if (rest.length < n) throw new Error(`tilr ctl ${verb}: ${what}`)
  }
  const number = (text, what) => {
    if (text === undefined || text === null) return undefined
    const n = Number(text)
    if (!(n >= 0)) throw new Error(`tilr ctl ${verb}: ${what} is a number, not ${text}`)
    return n
  }
  switch (verb) {
    case 'apps':
      return print((await shell({ cmd: 'apps' })).apps)
    case 'native-plugins':
      return print((await shell({ cmd: 'native-plugins' })).plugins)
    case 'native-call': {
      need(1, 'SERVICE [JSON request]')
      return print(await shell({ cmd: 'native-call', service: rest[0], request: rest[1] ? JSON.parse(rest[1]) : {} }))
    }
    case 'switch':
      need(1, 'which app')
      return print(await control({ cmd: 'switch', app: rest[0] }, { socket }))
    case 'reload':
      return print(await shell({ cmd: 'reload' }))
    case 'snapshot': {
      need(1, 'where to write the PNG')
      const r = await shell({ cmd: 'snapshot', path: resolve(expand(rest[0])) })
      return console.log(`${r.path} (${r.width}×${r.height})`)
    }
    case 'console': {
      const clear = has(rest, '--clear')
      const { messages } = await shell({ cmd: 'console', clear })
      for (const m of messages)
        console.log(`${new Date(m.time * 1000).toLocaleTimeString('en-GB')} ${m.type.padEnd(9)} ${m.text}`)
      return
    }
    case 'eval':
      need(1, 'the JavaScript')
      return print(await evaluate(rest.join(' '), options))
    case 'call': {
      need(1, 'SERVICE.METHOD, or an expression')
      const [target, ...args] = rest
      // An expression: `tilr ctl call '$.server.get("local").connect()'`.
      if (target.includes('(')) return print(await evaluate(`return (${rest.join(' ')})`, options))
      const dot = target.indexOf('.')
      // A bare SERVICE: the service itself, a callable one (`tilr ctl call open '{"kind":"url",…}'`).
      if (dot === -1) return print(await call(target, '', args.map(json), options))
      return print(await call(target.slice(0, dot), target.slice(dot + 1), args.map(json), options))
    }
    case 'plugins':
      return print(await plugins(options))
    case 'toggle':
      need(1, 'which plugin')
      await call('plugins', 'toggle', [rest[0]], options)
      return print((await plugins(options)).find(r => r.name === rest[0]) ?? `${rest[0]}: not in plugins.json`)
    case 'reload-plugin':
      need(1, 'which plugin')
      return print(await call('plugins', 'reload', [rest[0]], options))
    case 'windows':
      return print(await call('layout', 'list', [], options))
    case 'types':
      return print(await call('windows', 'list', [], options))
    case 'open': {
      need(1, 'which window type (tilr ctl types)')
      const float = has(rest, '--float')
      const [type, config] = rest
      return print(
        await call(
          'layout',
          'open',
          [{ type, ...(config !== undefined ? { config: json(config) } : {}), ...(float ? { mode: 'float' } : {}) }],
          options,
        ),
      )
    }
    case 'close':
      need(1, 'which window')
      return print(await call('layout', 'close', [rest[0]], options))
    case 'float':
      need(1, 'which window')
      return print(await call('layout', 'float', rest[1] ? [rest[0], json(rest[1])] : [rest[0]], options))
    case 'tile':
      need(1, 'which window')
      return print(await call('layout', 'tile', [rest[0]], options))
    case 'focus':
      need(1, 'which window')
      return print(await call('layout', 'focus', [rest[0]], options))
    case 'ui': {
      const json = has(rest, '--json')
      const window = flag(rest, '--window') ?? undefined
      const lines = number(flag(rest, '--lines'), '--lines')
      return print(
        await snapshot({ ...(window ? { window: await windowId(window, options) } : {}), json, lines, ...options }),
      )
    }
    case 'act': {
      // --wait [REGEX]: after the action, until the window is quiet (or its text matches).
      const at = rest.indexOf('--wait')
      let wait
      if (at !== -1) {
        const until = rest[at + 1]
        const taken = until !== undefined && !until.startsWith('--')
        rest.splice(at, taken ? 2 : 1)
        wait = taken ? { until } : {}
      }
      const lines = number(flag(rest, '--lines'), '--lines')
      need(
        2,
        'REF ACTION [VALUE] [--wait [REGEX]] [--lines N] (refs from tilr ctl ui; click dblclick fill select check uncheck focus press scroll)',
      )
      const [ref, action, ...value] = rest
      return print(await act(ref, action, value.length ? value.join(' ') : undefined, { wait, lines, ...options }))
    }
    case 'api': {
      const [service] = rest
      return print(describeText(await describe(service, options), service !== undefined))
    }
    case 'debug': {
      const path = flag(rest, '--path')
      const [action = 'status', seconds] = rest
      if (action === 'record') {
        const n = seconds === undefined ? undefined : Number(seconds)
        if (n !== undefined && !(n > 0)) throw new Error(`tilr ctl debug record: N is seconds, not ${seconds}`)
        const r = await debug('record', { seconds: n, ...(path ? { path: resolve(expand(path)) } : {}) }, { socket })
        console.log(r.path)
        for (const line of r.summary ?? []) console.log(line)
        return
      }
      if (action === 'metrics') {
        // The plugin's snapshot through eval: no native command needed.
        const filter = flag(rest, '--filter') ?? ''
        const json = has(rest, '--json')
        const data = await debugMetrics(options)
        if (!data) throw new Error('Performance collection is off (tilr ctl debug on)')
        const rows = metricRows(data, { filter })
        return console.log(json ? JSON.stringify(rows, null, 2) : metricsText(rows))
      }
      if (action === 'bench') {
        const json = has(rest, '--json')
        const seconds = number(flag(rest, '--seconds'), '--seconds')
        const size = number(flag(rest, '--size'), '--size')
        const out = flag(rest, '--out')
        const query = flag(rest, '--window')
        const which = rest[1] ?? 'all'
        const scenarios = which === 'all' ? SCENARIOS : [which]
        let window
        if (query) {
          const row = resolveWindow(query, await call('layout', 'list', [], options))
          if (row.type !== 'terminal')
            throw new Error(`tilr ctl debug bench: window ${row.id} is a ${row.type}, not a terminal`)
          window = row.id
        }
        const { result, dir } = await runBench({
          scenarios,
          seconds,
          size,
          window,
          socket,
          app,
          log: line => console.error(`[bench] ${line}`),
        })
        const written = await writeBench(result, { out: out ? resolve(expand(out)) : undefined, dir })
        console.log(json ? JSON.stringify(result, null, 2) : `${benchText(result)}\n${written}`)
        if (json) console.error(written)
        if (result.error) {
          console.error(`[bench] failed: ${result.error}; the partial result is in ${written}`)
          process.exitCode = 1
        }
        return
      }
      if (action === 'memory') {
        const json = has(rest, '--json')
        const seconds = number(flag(rest, '--seconds'), '--seconds') ?? 120
        const interval = number(flag(rest, '--interval'), '--interval') ?? 5
        const out = flag(rest, '--out')
        const squeeze = !has(rest, '--no-squeeze')
        const { result, dir } = await runMemory({
          seconds,
          interval,
          squeeze,
          socket,
          app,
          log: line => console.error(`[memory] ${line}`),
        })
        const written = await writeBench(result, { out: out ? resolve(expand(out)) : memoryPath(dir) })
        console.log(json ? JSON.stringify(result, null, 2) : `${memoryText(result)}\n${written}`)
        if (json) console.error(written)
        if (result.error) {
          console.error(`[memory] failed: ${result.error}; the partial result is in ${written}`)
          process.exitCode = 1
        }
        return
      }
      // The Mac app's own when it has them, else the page's Performance service.
      if (action === 'footprint') {
        const json = has(rest, '--json')
        const reply = await debugFootprint({ socket, app })
        return console.log(json ? JSON.stringify(reply, null, 2) : footprintText(reply))
      }
      if (action === 'squeeze') return console.log(squeezeText(await debugSqueeze({ socket, app })))
      if (action === 'inspect') {
        const reply = await debugInspect({ socket, app })
        console.log(inspectText(reply))
        if (!reply.shown) process.exitCode = 1
        return
      }
      if (action === 'compare') {
        const threshold = number(flag(rest, '--threshold'), '--threshold') ?? 10
        const [, a, b] = rest
        if (!a || !b) throw new Error('tilr ctl debug compare A.json B.json [--threshold PCT]')
        const read = async path => JSON.parse(await readFile(resolve(expand(path)), 'utf8'))
        const result = compareBench(await read(a), await read(b), { threshold })
        for (const warning of result.warnings) console.error(`[compare] warning: ${warning}`)
        console.log(compareText(result))
        if (result.regressed) process.exitCode = 1
        return
      }
      if (!['status', 'on', 'off'].includes(action))
        throw new Error(
          'tilr ctl debug: status | on | off | record [N] [--path P] | metrics [--filter PREFIX] [--json] | bench [all|typing|throughput|idle] [--seconds N] [--size N] [--out FILE] [--window W] [--json] | compare A.json B.json [--threshold PCT] | memory [--seconds N] [--interval S] [--no-squeeze] [--out FILE] [--json] | footprint [--json] | squeeze | inspect',
        )
      return console.log(debugText(await debug(action, {}, { socket })))
    }
    default:
      usage()
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(`[tilr] ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
