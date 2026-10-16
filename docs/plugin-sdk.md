# The plugin SDK

What a plugin repo gets from `@tilr-dev/plugin` (0.1.14 and later) besides the API types and the
harness: one build, one set of configs, one command, and the runtime helpers every plugin used to
copy. A plugin repo that uses all of it is its sources, its tests and a handful of one-line files.
The proposal this implements is [SDK.md](SDK.md); the rules for plugins are
[GUIDELINES.md](GUIDELINES.md) and the README (Writing a plugin, Versioning).

## A plugin repo

Start from the template repo, [tilr-dev/plugin-template](https://github.com/tilr-dev/plugin-template)
("Use this template", or `gh repo create my-plugin --template tilr-dev/plugin-template --clone`),
then `npm install && npx tilr-plugin init my-plugin`. Its name is in two places, `tilr.name` in
package.json and `const NAME` in `src/index.ts`; `init` sets both.

```text
package.json          name, version, tilr.name, the scripts below, dev dependencies
build.mjs             optional: import { buildPlugin } from '@tilr-dev/plugin/build'; await buildPlugin({ … })
playwright.config.ts  export { default } from '@tilr-dev/plugin/playwright'
tsconfig.json         { "extends": "@tilr-dev/plugin/tsconfig.plugin.json", "include": ["src"] }
tsconfig.test.json    { "extends": "@tilr-dev/plugin/tsconfig.plugin-test.json" }
eslint.config.js      import { withRoot } from '@tilr-dev/plugin/eslint'; export default withRoot(import.meta.dirname)
src/index.ts(x)       the plugin
src/api.ts            optional: the service's types → dist/api.d.ts
test/*.spec.ts        e2e on the harness (@tilr-dev/plugin/test)
src/**/*.test.ts      optional: unit tests (node --test)
```

The canonical `package.json` (no `test/global-setup.ts`, no `scripts/install-site.mjs`: the
SDK has both):

```json
{
  "name": "@tilr-dev/plugin-clock",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "tilr": { "name": "clock" },
  "scripts": {
    "build": "tilr-plugin build",
    "dev": "tilr-plugin build --watch",
    "dev:site": "tilr-plugin dev",
    "install:site": "tilr-plugin build --install",
    "check": "tsc --noEmit && tsc --noEmit -p tsconfig.test.json && eslint .",
    "test": "npm run test:unit && npm run test:e2e",
    "test:unit": "node --test 'src/**/*.test.ts'",
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@tilr-dev/plugin": "file:../../web",
    "@eslint/js": "^10.0.1",
    "@playwright/test": "^1.64.0",
    "@types/node": "^26.6.4",
    "cordis": "npm:@deepseek-ai/cordis@4.0.1",
    "esbuild": "^0.28.2",
    "eslint": "^10.12.0",
    "typescript": "~6.0.3",
    "typescript-eslint": "^8.71.1"
  }
}
```

The same block with or without unit tests (`node --test` with nothing to run passes). If a unit
test imports `dist/index.js` (the built plugin, whose `'tilr'`, `'tilr/ui'`, `'cordis'`, `'react'`
imports are left for the page's import map), `test:unit` builds first and adds
`--import @tilr-dev/plugin/test/node`, a resolve hook that maps those names to the SDK's site/ as
the import map does (`tilr-plugin build && node --import @tilr-dev/plugin/test/node --test
'src/**/*.test.ts'`, as in menu and files); tests of plain helpers (`src/lib.ts`) need neither. A React
plugin adds `@types/react`. A plugin that
types another plugin's service adds that repo as a `file:` dev dependency (see `optional()`).

## `tilr-plugin`

The bin the scripts call, run in the plugin repo:

| Command | What it does |
| --- | --- |
| `tilr-plugin build [--watch] [--install] [--site DIR]` | `node build.mjs …` when the repo has one, else `buildPlugin()` with the defaults |
| `tilr-plugin dev [--site DIR]` | `build --watch --install`: rebuild on every save, install each good build |
| `tilr-plugin init <name> [--force]` | fills a fresh copy of the template repo in as the plugin `<name>`: package.json (name, `tilr.name`, version, URLs from the git `origin`), `const NAME` in `src/index.ts(x)`, README.md, AGENTS.md; `--force` for a repo that is not the template |
| `tilr-plugin install-site [--site DIR]` | `dist/` → `plugins/<name>/` of the Tilr site, the name appended to `plugins.json` |
| `tilr-plugin uninstall-site [--site DIR] [name]` | `name` (default: the repo's) out of `plugins.json`, then `plugins/<name>/` removed; a no-op when it is not there |

The site is `--site DIR`, else `$TILR_SITE`, else `site:` in the app's config, else the app's
default folder (README, Installing into the site folder). Installing refuses a site without the
core page (`npm run install:site` in `web` first). Every command checks the Node version first
(`engines`: >=22.18) and says which Node it found.

## `buildPlugin()` — `@tilr-dev/plugin/build`

```js
// build.mjs, all defaults (the same as having no build.mjs at all)
import { buildPlugin } from '@tilr-dev/plugin/build'
await buildPlugin()
```

| Option | Default | |
| --- | --- | --- |
| `entry` | `src/index.tsx`, else `src/index.ts` | its output is `dist/index.js` |
| `bundle` | `true` | `false`: the entry alone, types stripped, imports untouched |
| `api` | `src/api.ts` when it exists | copied to `dist/api.d.ts`; `false`: none |
| `assets` | `.css .json .svg .png .jpg .webp .woff2 .txt .md` | copied from the entry's folder, same relative path |
| `copy` | `{}` | dist path → file, for files from elsewhere (`{ 'onig.wasm': 'node_modules/shiki/dist/onig.wasm' }`) |
| `define` | `{}` | more esbuild defines (values are code) |
| `esbuild` | `{}` | more esbuild options, or `build => options` per build (below) |
| `hooks.after` | none | `({ out, dist, version, api, result, files, … }) => …`, before the swap |
| `argv` | `process.argv.slice(2)` | `--watch`, `--install`, `--site DIR` |
| `root` | `process.cwd()` | the plugin repo |

What every build does:

- **Bundled** (default): esbuild bundles the entry and what it imports into `dist/index.js` (+
  `index.js.map`, linked), platform browser, ESM, `safari17`. The page's import map stays as bare
  imports: `tilr`, `tilr/react`, `tilr/ui`, `tilr/native`, `cordis`, `@deepseek-ai/cosmokit`,
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client` (`IMPORT_MAP`), so the plugin runs
  on the page's cordis and React. A plugin that must carry its own React (webamp) passes
  `esbuild: { external: ['tilr', 'cordis'] }`.
- **`bundle: false`**: `dist/index.js` is the entry with its types stripped and an inline
  sourcemap, what the template's build did. Every import is checked first; one the page cannot
  resolve fails the build instead of a 404 after installing:

  ```text
  ✘ [ERROR] src/index.ts imports 'lodash': only the page's import map resolves a bare name
    (cordis, @deepseek-ai/cosmokit, tilr, …). Bundle the plugin (bundle: true) or drop the import.
  ```

  A relative import fails the same way (the plugin is one file), and so do a side-effect import
  (`import './x.js'`), a re-export (`export … from`) and a dynamic `import('./x.js')`.
  `import type` is erased and always fine. Other `.ts` files in `src/` get a warning.
- **The versions**: `__TILR_VERSION__` is package.json's `version`, `__TILR_API__` the plugin
  API version (`tilrApi`, not the package version) of the `@tilr-dev/plugin` the repo has
  installed (the API it builds against; this package's own when it is not installed). Both re-read on every build, so a version bump under `--watch`
  takes effect. `dist/index.js` ends with the build's stamp,
  `export const __tilrBuild = { version, api: '^' + __TILR_API__ }`, from which the runtime
  fills in the `version` and `api` a plugin leaves out (see `definePlugin` below). Source that
  has a `__tilrBuild` of its own fails the build (two exports of the name would not load).
- **Atomic**: the build writes into a temp folder (`node_modules/.cache/tilr-plugin-build/`, or
  `.tilr-build/` in a repo without `node_modules`), runs `hooks.after` there, and only then
  replaces `dist/` as a whole (two renames; the old one is put back if the second fails). A
  compile error, a missing output or a throwing hook leaves the last good `dist/`, and the build
  exits 1. `dist/` is always a plain folder: a symlink there is replaced, its target left alone.
  What a build stopped midway (Ctrl-C) left in the cache, the next build removes.
- **`--install`**: after a good build, `installPlugin()` (`@tilr-dev/plugin/install`'s rules:
  mirrored folder, assets before `index.js`, `plugins.json` merged). Without `--watch` a failed
  install exits 1.
- **`--watch`**: builds, then rebuilds 30 ms after the last change under the entry's folder or
  to `package.json`, one build at a time; changes made during a build make one more build, which
  sees them all. A failed build or install is logged; the watch goes on.

### Options for a plugin with outputs of its own

`esbuild` merges with the shared options: `define`, `loader` and `alias` key by key, `plugins`
appended, everything else replaced (`minify`, `external`, `entryPoints` — which must keep an
entry named `index`). As a function it runs once per build, before the main build, with the
build's context (`root`, `out` the temp folder, `dist`, `version`, `api`, `name`, `entry`,
`watching`), so it can build something first and pass the result on. Editor's build, for
example, would be:

```js
import * as esbuild from 'esbuild'
import { buildPlugin } from '@tilr-dev/plugin/build'

await buildPlugin({
  copy: { 'onig.wasm': 'node_modules/shiki/dist/onig.wasm' },
  async esbuild({ out }) {
    const { files, table } = await buildLangs()            // the lazy grammars, write: false
    for (const file of files) await writeInto(out, 'langs', file)
    return {
      entryPoints: { index: 'src/index.tsx', 'editor.worker': WORKER },
      minify: true,
      loader: { '.ttf': 'file' },
      assetNames: '[name]-[hash]',
      plugins: [slimMain, dropMonarch],
      define: { __SHIKI_LANGS__: JSON.stringify(table) },
    }
  },
})
```

`hooks.after({ out, files, result })` runs after the main build and before the swap, for what
must see the main build's output (`result` is esbuild's, with `metafile` when asked for).

The other exports: `installPlugin({ root?, argv? })`, `checkNode(version?, range?)`,
`apiVersion(root?)`, `stamp(code, { version, api })`, `IMPORT_MAP`, `ASSETS`, `STAMP`; types in
`tools/build-plugin.d.mts`.

`@tilr-dev/plugin/test/node` (tools/node-resolve.mjs), for `node --import`: a resolve hook mapping
each import map name (`SITE_FILES`: `'tilr'` → `site/tilr.js`, `'tilr/ui'` → `site/tilr/ui.js`,
`'cordis'` → `site/vendor/cordis.js`, `'react'` → `site/vendor/react.js`, …) to the package's
built site/, so Node runs a built plugin against the real modules (none needs a DOM to be
imported; what `apply` then touches is the test's to fake). It throws, naming the build to run,
if site/ is missing (a `file:`-linked SDK that was never built).

## Configs

- **Playwright** — `export { default } from '@tilr-dev/plugin/playwright'`: `testDir: 'test'`,
  WebKit (Desktop Safari), headless, `reporter: 'list'`, `retries: 0`, fully parallel, and
  `globalSetup: @tilr-dev/plugin/test/global-setup`, which runs `tilr-plugin build` in the
  plugin's folder before the specs (its build.mjs, or the defaults). The config takes
  `@playwright/test` from the plugin's own node_modules (Playwright refuses two copies, and a
  `file:`-linked SDK would otherwise bring the core repo's). To change something:
  `import config from '@tilr-dev/plugin/playwright'; export default { ...config, timeout: 60_000 }`.
- **TypeScript** — `tsconfig.plugin.json` is `tsconfig.base.json` (strict, erasable syntax only,
  `verbatimModuleSyntax`, `isolatedModules`, no ambient Node types, `jsx: react-jsx`,
  `__TILR_VERSION__` / `__TILR_API__` from `globals.d.ts`) plus the `paths` every plugin repeated:
  `tilr`, `tilr/react`, `tilr/ui`, `tilr/native` → the package's `api/` (relative to the SDK's own
  file, so linked or installed alike) and `cordis` → the plugin's `node_modules/cordis`
  (`${configDir}`), so that another plugin's declarations installed with `file:` see the same
  cordis. `include: src`, unit tests excluded. `.ts` and `.tsx` alike. `tsconfig.plugin-test.json`
  adds Node's types and `allowImportingTsExtensions` for `src/**/*.test.ts(x)`, `test/` and
  `playwright.config.ts`. A plugin with extra `paths` repeats the SDK's in its own tsconfig
  (`paths` replaces, it does not merge).
- **ESLint** — `withRoot(import.meta.dirname)` from `@tilr-dev/plugin/eslint`: the shared rules (no
  `any`, no `!`, no `@ts-ignore` without a reason, no floating promises, explicit module
  boundary types, type-only imports) with the repo's tsconfigs, for `.ts` and `.tsx`. The
  default export is the same array without a root.

## Runtime helpers

All of them are in the page (the import map's `tilr`, `tilr/ui`, `tilr/native`), not bundled
into the plugin. They need a page with API 0.1.14 or later: a plugin that uses them is built
against 0.1.14 or later, and its stamped `api` (`'^0.1.14'`) says so.

### `frame(win, options?)` and `element(tag, className?, text?)` — `tilr/ui`

The standard window frame for a window drawn with the DOM, what `<Frame>` is for React:

```ts
import { definePlugin, onLayout } from 'tilr'
import { element, frame } from 'tilr/ui'

export default definePlugin({
  name: 'clock',
  inject: ['windows'],
  apply(ctx) {
    ctx.windows.register('clock', {
      open: 'once',
      title: 'clock',
      mount(host, win) {
        const { tile, body, dispose } = frame(win, { className: 'clock-tile' })
        const time = element('div', 'big', new Date().toLocaleTimeString())
        body.append(time)
        host.append(tile)
        const id = setInterval(() => { time.textContent = new Date().toLocaleTimeString() }, 1000)
        return () => { clearInterval(id); dispose() }
      },
    })
  },
})
```

`frame()` builds `<section class="tile [className]"><header data-window-drag>…</header><div
class="controls">…</div><div class="body"></div></section>` and returns `{ tile, header, controls,
body, dispose }`. The buttons: float / tile (`data-float`, `aria-label="float or tile"`,
`data-call` `layout.float` or `layout.tile` after the mode), only for a type with two modes or
more, and close (`data-close`, `aria-label="close"`, `data-call="layout.close"`); they follow the
window's `mode` / `modes`. `title` omitted: the header shows the window's title and follows it;
a string: that text; `null`: the plugin writes the header. `controls: false`: no buttons (a
plugin's own controls can always be prepended to `controls`). `dispose()` stops following the
window and removes the tile.

One description serves all three frames: `frameControls(win)` (the buttons for the window as it
is now: id, label, text, `data-call`, `run()`) and `FRAME` (the class names and the drag
attribute) are what `frame()`, the React `<Frame>` and `ctx.ui.tile()` draw from, so their
markup and agent attributes cannot drift apart again.

`element('input', 'field')` is `document.createElement` with a class and a text, typed by tag
(`HTMLInputElement` here).

### `onLayout(ctx, listener, { ignore? })` — `tilr`

`ctx.on('layout/change', …)` minus the kinds in `ignore`. What every list that redraws on a
change of the windows wrote by hand (`if (change?.kind !== 'title') draw()`):

```ts
const off = onLayout(ctx, draw, { ignore: ['title'] })   // an effect of ctx, like ctx.on; off() sooner
```

The listener gets the change (`LayoutChange`: `undefined`, or `{ kind: 'title', id }`).

### `optional(ctx, services, apply)` — `tilr`

An optional dependency: `apply` runs in a scope of its own while the named services exist, is
undone when one goes and runs again when it is back; the plugin itself does not wait for them.
It is `ctx.inject(names, apply)` with the names checked against `TilrServices` and `ctx` narrowed
to them, as `definePlugin` does:

```ts
import { definePlugin, optional } from 'tilr'
import type {} from '@tilr-dev/plugin-menu/api'   // the 'menu' service's types (erased by the build)

export default definePlugin({
  name: 'notes',
  inject: ['windows'],
  apply(ctx) {
    optional(ctx, 'menu', ctx => ctx.menu.contribute(target => target.type === 'notes' ? [{ label: 'Clear', run: clear }] : null))
    optional(ctx, ['layout', 'notifications'], ctx => { /* both, or neither */ })
  },
})
```

Another plugin's service is typed by its published declarations: the provider's `src/api.ts`
(its `declare module 'tilr' { interface TilrServices { menu: Menu } }`), reached through a dev
dependency on its repo (`"@tilr-dev/plugin-menu": "file:../menu"`, its package.json exporting
`./api`) and a type-only import, `import type {} from '@tilr-dev/plugin-menu/api'`, which adds
the augmentation and leaves nothing in the build. `optional()` returns the scope (a cordis
`Fiber`); `void scope.dispose()` ends it sooner, e.g. with the window it belongs to.

### `definePlugin` defaults: `version` and `api`

A plugin built by `buildPlugin()` may leave out `version` and `api`:

```ts
export default definePlugin({ name: 'clock', inject: ['windows'], apply(ctx) { … } })
// runs as version: <package.json's version>, api: '^<@tilr-dev/plugin version built against>'
```

`definePlugin` itself runs in the page's `tilr.js`, where the plugin's build constants are not
defined (`__TILR_VERSION__` there is the core's). So the build stamps them onto `dist/index.js`
(`__tilrBuild`), and the runtime fills them into the default export where it has none, before
the version checks and the panel read them. That covers every shape the same way: an object from
`definePlugin`, a `windowType()` from `tilr/react`, and a class plugin, whose `static version` /
`static api` are filled in when the class (or a base class) does not declare them. A plugin's own
`version` / `api` always win; `requires` stays explicit. A plugin built some other way (the
core's own, a hand-written file) gets no defaults: no `api` means no check.

### `connectNative()` and `nativeChannel()` — `tilr/native`

The bridge to the Mac app's native side, in one place: the `webkit.messageHandlers` global type
and the handler detection.

```ts
import { connectNative, hasNative } from 'tilr/native'

if (hasNative()) {
  ctx.effect(() => {
    const native = connectNative()                       // the app's tilrNative handler
    void native.describe().then(providers => …)          // [{ id, version, channels, events }]
    void native.send('audio', 'audio', { op: 'list' })   // resolves { accepted: true } on dispatch
    const off = native.on('tilr-audio', detail => …)     // a provider's event on window
    return () => { off(); native.dispose() }
  })
}
```

`connectNative({ window?, timeout? })` correlates replies by id, rejects on the app's error or
after `timeout` (10 s), and refuses calls after `dispose()`; outside the app it throws "Tilr
native plugins are unavailable" (check `hasNative()` for a web fallback). It replaces
native-plugins' former `SDK/web/native.mjs`, typed and moved into the page. `nativeChannel(handler,
event)` is the older per-service form the core's `audio`, `webviews` and `sshagent` use
(`tilrAudio` / `tilr-audio` …): `{ post(body), listen(fn) }`, or `null` outside the app.
