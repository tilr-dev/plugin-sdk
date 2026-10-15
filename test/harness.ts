// The e2e harness: serve a composed Tilr site and drive it through window.tilr. A library, not a
// test file: no Playwright `test` globals in here, only `Page` from @playwright/test, so a plugin
// that lives in its own repo can import it (`@tilr-dev/plugin/test`, built to dist/test/) and run
// against the core's built site/, which ships in the package:
//
//   const server = await serveSite({ site: coreSite(), plugins: ['store', 'theme', 'panel', 'counter', 'stats'],
//     overlays: { stats: './dist', counter: await pluginDir(fakeProvider('counter', { ... })) } })
//   const t = tilr(page)
//   await t.open(server)
//   await t.waitForState('stats', 'active')
//
// The core's own specs (test/*.spec.ts) are its first users; test/plugin-isolation.spec.ts is
// the pattern for a standalone plugin. Only node: modules at runtime: the type imports are erased,
// and 'tilr' is the API's types (src/ here, api/ in the package; see tsconfig.harness.json).
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { PluginRow, PluginState } from 'tilr'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

export interface SiteOptions {
  /** The built core: a folder with index.html, runtime.js, tilr.js, vendor/ (this repo's site/). */
  site: string
  /** The names served as plugins.json, in order. */
  plugins: string[]
  /** Plugin folders mounted at plugins/<name>/ from anywhere on disk (a plugin repo's dist/, a
   *  temp dir from pluginDir()). A mount shadows site/plugins/<name>/ entirely. */
  overlays?: Record<string, string>
}

export interface Site {
  /** http://127.0.0.1:<port>/ */
  url: string
  /** What plugins.json lists right now. */
  readonly names: string[]
  /** Serves plugins/<name>/ from `dir` from now on: "the file changed on disk". Follow it with
   *  `tilr(page).hmr(['plugins/<name>/index.js'])`, as the native app would. */
  mount(name: string, dir: string): void
  /** Back to site/plugins/<name>/ (a 404 for a name the site does not have). */
  unmount(name: string): void
  /** Rewrites plugins.json; follow it with `hmr(['plugins.json'])`. */
  setPluginsJson(names: string[]): void
  close(): Promise<void>
}

/**
 * The built core this harness belongs to: `<package>/site`. The package root is the nearest
 * folder above this module with a package.json (test/ in the core repo, dist/test/ in the
 * installed package), so a plugin repo never spells out node_modules paths.
 */
export function coreSite(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir)
    if (up === dir) throw new Error(`no package.json above ${fileURLToPath(import.meta.url)}`)
    dir = up
  }
  return join(dir, 'site')
}

/**
 * Starts a static server on 127.0.0.1 (random port) for a composed site: `site` + the mounts +
 * a generated plugins.json. Every response is `Cache-Control: no-store`; queries (`?v=` from the
 * runtime's cache busting) are ignored.
 */
export async function serveSite({ site, plugins, overlays = {} }: SiteOptions): Promise<Site> {
  const root = resolve(site)
  const mounts = new Map(Object.entries(overlays).map(([name, dir]) => [name, resolve(dir)]))
  let names = [...plugins]

  /** The file on disk for a URL path, or null (outside every root, or no such file). */
  async function locate(path: string): Promise<string | null> {
    const match = /^plugins\/([^/]+)\/(.+)$/.exec(path)
    const [base, rest] = match && mounts.has(match[1]) ? [mounts.get(match[1]) ?? '', match[2]] : [root, path || 'index.html']
    const file = normalize(join(base, rest))
    if (file !== base && !file.startsWith(base + sep)) return null
    try { return (await stat(file)).isFile() ? file : null } catch { return null }
  }

  const server = createServer((request, response) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      response.end(body)
    }
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname).replace(/^\/+/, '')
    if (path === 'plugins.json') return send(200, MIME['.json'], JSON.stringify({ plugins: names }))
    locate(path).then(async file => {
      if (!file) return send(404, MIME['.txt'], `not found: ${path}`)
      send(200, MIME[extname(file)] ?? 'application/octet-stream', await readFile(file))
    }).catch((error: unknown) => send(500, MIME['.txt'], String(error)))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo  // listening on TCP: an AddressInfo

  return {
    url: `http://127.0.0.1:${port}/`,
    get names() { return [...names] },
    mount(name, dir) { mounts.set(name, resolve(dir)) },
    unmount(name) { mounts.delete(name) },
    setPluginsJson(next) { names = [...next] },
    close: () => new Promise<void>((done, fail) => {
      server.closeAllConnections()
      server.close(error => error ? fail(error) : done())
    }),
  }
}

/** The names in a built site's plugins.json. */
export async function sitePlugins(site: string): Promise<string[]> {
  const json: unknown = JSON.parse(await readFile(join(site, 'plugins.json'), 'utf8'))
  const plugins = typeof json === 'object' && json !== null && 'plugins' in json ? json.plugins : null
  if (!Array.isArray(plugins)) throw new Error(`${site}/plugins.json: expected { "plugins": [names] }`)
  return plugins.filter((name): name is string => typeof name === 'string')
}

// Temp plugin folders live under one directory, removed when the test process exits.
let temp: string | null = null

/** Writes a plugin folder to a fresh temp dir and returns its path, to `mount()` or pass in
 *  `overlays`. `files` is the source of index.js, or file name → contents. */
export async function pluginDir(files: string | Record<string, string>): Promise<string> {
  if (!temp) {
    const dir = mkdtempSync(join(tmpdir(), 'tilr-test-'))
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
    temp = dir
  }
  const dir = mkdtempSync(join(temp, 'plugin-'))
  for (const [name, text] of Object.entries(typeof files === 'string' ? { 'index.js': files } : files)) {
    await writeFile(join(dir, name), text)
  }
  return dir
}

/** What a fake's methods see as `this`: the state holder, `emit` for events, and the rest of
 *  its own members. */
export interface FakeThis<S> {
  state: S
  /** `ctx.emit` from the fake's context, e.g. `this.emit('counter/change', this.state.value)`. */
  emit(event: string, ...args: unknown[]): void
  [member: string]: unknown
}

/** A fake service: `state` (copied for each start, JSON only), `version` (the provider's
 *  `static version`, what a plugin's `requires` is checked against; unset, the fake is
 *  unversioned and fails every `requires` on it) plus members written as methods
 *  (`add(n) { … }`), getters (`get value() { … }`) or setters. Members are sent as source text,
 *  so they must not close over anything in the test. */
export type FakeImpl<S extends object> = { state?: S, version?: string } & Record<string, unknown> & ThisType<FakeThis<S>>

/**
 * The source of a minimal plugin that provides service `name`: a `Service` subclass with
 * `static provide = name`, so a plugin under test can `inject: [name]` without the real
 * provider. Write it with `pluginDir()` and mount it at plugins/<name>/. In the page the running
 * instance is `window.__fakes[name]`; `tilr(page).fake(name)` reads and drives it.
 *
 *   fakeProvider('counter', { version: '0.1.0', state: { value: 7 }, get value() { return this.state.value } })
 */
export function fakeProvider<S extends object>(name: string, impl: FakeImpl<S>): string {
  const members: string[] = []
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(impl))) {
    if (key === 'state' || key === 'version') continue
    if (descriptor.get || descriptor.set) {
      if (descriptor.get) members.push(descriptor.get.toString())
      if (descriptor.set) members.push(descriptor.set.toString())
      continue
    }
    const value: unknown = descriptor.value
    const source = typeof value === 'function' ? value.toString() : ''
    // Method shorthand prints as a class member (`add(n) { … }`); an arrow or `function` does not.
    if (!new RegExp(`^(async\\s*)?(\\*\\s*)?${key.replace(/[$]/g, '\\$')}\\s*\\(`).test(source)) {
      throw new Error(`fakeProvider('${name}'): ${key} must be a method (\`${key}() { … }\`), a getter or a setter`)
    }
    members.push(source)
  }
  const id = JSON.stringify(name)
  return `// A fake '${name}' service, generated by fakeProvider() (@tilr-dev/plugin/test).
import { Service } from 'cordis'

const STATE = ${JSON.stringify(impl.state ?? {})}

class Fake extends Service {
  static provide = ${id}
  static tags = ['fake']${impl.version === undefined ? '' : `\n  static version = ${JSON.stringify(impl.version)}`}

  constructor(ctx) {
    super(ctx, ${id})
    this.state = structuredClone(STATE)
    // The handle the test drives (tilr(page).fake(${id})); it leaves with the plugin.
    ctx.effect(() => {
      const fakes = (window.__fakes ??= {})
      fakes[${id}] = this
      return () => { if (fakes[${id}] === this) delete fakes[${id}] }
    }, 'fake handle')
  }

  emit(event, ...args) { this.ctx.emit(event, ...args) }

${members.map(member => `  ${member}`).join('\n\n')}
}

export default Fake
`
}

declare global {
  interface Window {
    /** The running fakes by service name (fakeProvider()). */
    __fakes?: Record<string, FakeThis<Record<string, unknown>>>
  }
}

/** A row as it crosses from the page: the Error reduced to its message. */
type WireRow = Omit<PluginRow, 'error'> & { error: string | null }

export interface Tilr {
  /** Loads the site and waits until every plugin in plugins.json has a row and none is loading. */
  open(site: Site): Promise<void>
  /** `ctx.plugins.list()` in the page (window.tilr.root.get('plugins')). */
  list(): Promise<PluginRow[]>
  /** One row; throws when the name is not in plugins.json. */
  row(name: string): Promise<PluginRow>
  /** What the native app does when files change: `window.tilr.hmr.changed(paths)`. Resolves to
   *  the runtime's note. */
  hmr(paths: string[]): Promise<string>
  toggle(name: string): Promise<void>
  reload(name: string): Promise<string>
  /** Waits for a plugin's row to reach `state`; on timeout the error lists every row. */
  waitForState(name: string, state: PluginState, timeout?: number): Promise<void>
  /** The titles of the tiles in #grid, in order. */
  tiles(): Promise<string[]>
  /** Console errors and uncaught page errors since tilr(page) was called. */
  consoleErrors(): string[]
  /** Reads and drives a fakeProvider() service running in the page. */
  fake(name: string): {
    state(): Promise<unknown>
    /** Merges `patch` into the fake's state (no event). */
    set(patch: Record<string, unknown>): Promise<void>
    emit(event: string, ...args: unknown[]): Promise<void>
  }
}

/** Drives a Tilr page through its public API. Call it before `open()` so that console errors
 *  from the boot are collected. */
export function tilr(page: Page): Tilr {
  const errors: string[] = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(`${error.name}: ${error.message}`))

  const list = async (): Promise<PluginRow[]> => {
    const rows = await page.evaluate(() => {
      const host = window.tilr.root.get('plugins')
      if (!host) throw new Error('no plugins service')
      return host.list().map((row): WireRow => ({ ...row, error: row.error ? row.error.message : null }))
    })
    return rows.map(row => ({ ...row, error: row.error === null ? null : new Error(row.error) }))
  }
  const t: Tilr = {
    async open(site) {
      await page.goto(site.url)
      // Settled: every row is running, failed, incompatible, or switched off. 'pending' (waiting
      // for a service) and 'loading' are transitions: a plugin listed after its provider passes
      // through them on boot.
      await page.waitForFunction(count => {
        const rows = window.tilr?.root.get('plugins')?.list()
        return rows?.length === count && rows.every(r =>
          r.state === 'active' || r.state === 'failed' || r.state === 'incompatible' || (r.state === 'off' && !r.enabled))
      }, site.names.length)
    },
    list,
    async row(name) {
      const row = (await list()).find(r => r.name === name)
      if (!row) throw new Error(`${name}: not in plugins.json`)
      return row
    },
    hmr: paths => page.evaluate(paths => window.tilr.hmr.changed(paths), paths),
    toggle: name => page.evaluate(name => window.tilr.root.get('plugins')?.toggle(name), name),
    reload: name => page.evaluate(name => window.tilr.root.get('plugins')?.reload(name) ?? 'no plugins service', name),
    async waitForState(name, state, timeout = 5000) {
      try {
        await page.waitForFunction(([name, state]) =>
          window.tilr?.root.get('plugins')?.list().find(r => r.name === name)?.state === state, [name, state] as const, { timeout })
      } catch (error) {
        const rows = (await list()).map(r => `${r.name}=${r.state}${r.error ? ` (${r.error.message})` : ''}`)
        throw new Error(`${name} did not reach '${state}' in ${timeout}ms; rows: ${rows.join(', ')}`, { cause: error })
      }
    },
    tiles: () => page.locator('#grid .tile > header').allTextContents(),
    consoleErrors: () => [...errors],
    // Each callback runs in the page, so the lookup is repeated rather than shared.
    fake: name => ({
      state: () => page.evaluate(name => {
        const fake = window.__fakes?.[name]
        if (!fake) throw new Error(`no fake '${name}' running`)
        return fake.state
      }, name),
      set: patch => page.evaluate(([name, patch]) => {
        const fake = window.__fakes?.[name]
        if (!fake) throw new Error(`no fake '${name}' running`)
        Object.assign(fake.state, patch)
      }, [name, patch] as const),
      emit: (event, ...args) => page.evaluate(([name, event, args]) => {
        const fake = window.__fakes?.[name]
        if (!fake) throw new Error(`no fake '${name}' running`)
        fake.emit(event, ...args)
      }, [name, event, args] as const),
    }),
  }
  return t
}
