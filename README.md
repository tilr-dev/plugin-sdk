# @tilr-dev/plugin

The kit for writing a Tilr plugin in its own repo. A Tilr page is a cordis
root context plus hot-reloadable plugins; a plugin is one `index.js` the page loads from
`plugins/<name>/`. This package is everything a plugin repo builds, checks and tests against:

- the **plugin API's types** (`api/`, what `'tilr'`, `'tilr/react'`, `'tilr/ui'`, `'tilr/native'`
  are for tsc),
- the **shared build** (`@tilr-dev/plugin/build`) and the **CLI** (`tilr-plugin`),
- the **e2e harness** (`@tilr-dev/plugin/test`) and the **built core page** it serves (`site/`),
- the **shared configs**: tsconfig, oxlint, Playwright, and the repo standard's checks
  (`tilr-plugin verify`) with their presets: Biome (format), lefthook (git hooks), commitlint,
  jscpd, knip; and `tilr-plugin init`, which fills a copy of the
  [template repo](https://github.com/tilr-dev/plugin-template) in as a new plugin.

The page itself (the runtime and the built-in plugins) lives in the core repo, `web/`; this
package carries a built copy of it (see Keeping api/ and site/ in sync). Docs:
[docs/plugin-sdk.md](docs/plugin-sdk.md) (the whole kit with examples),
[docs/GUIDELINES.md](docs/GUIDELINES.md) (rules for plugins), [docs/SDK.md](docs/SDK.md) (the
design it implements), [CHANGELOG.md](CHANGELOG.md).

## Install

Node >= 22.18.

**A new plugin:** start from the template repo (see A plugin repo below); its package.json
already lists every dev dependency, so `npm install` is all it takes.

**An existing project:** pick what you need.

- Types and the build only:

  ```sh
  npm install -D @tilr-dev/plugin cordis@npm:@deepseek-ai/cordis@4.0.1 esbuild typescript
  ```

- The whole kit (build, lint, e2e tests, `tilr-plugin verify`):

  ```sh
  npm install -D @tilr-dev/plugin cordis@npm:@deepseek-ai/cordis@4.0.1 esbuild typescript \
    oxlint oxlint-tsgolint @playwright/test @types/node lefthook
  npx playwright install webkit      # once per machine
  ```

Add `@types/react` if the plugin renders with React.

Why the list: npm installs a package's required peers, but not its optional ones, and only
`cordis` is required here. It has to be named anyway: Tilr uses the `@deepseek-ai/cordis` build
under the name `cordis`, which npm cannot pick on its own (the `cordis` package on npm is the
upstream one, without a 4.0.1).

## A plugin repo

Start from the template repo, [tilr-dev/plugin-template](https://github.com/tilr-dev/plugin-template),
not from another plugin: "Use this template" on GitHub, or

```sh
gh repo create my-plugin --template tilr-dev/plugin-template --clone
cd my-plugin
npm install && npx tilr-plugin init my-plugin
```

`tilr-plugin init` fills the copy in as the plugin `my-plugin` (CLI below). A repo that uses the
whole kit is its sources, its tests and one-line config files:

```text
package.json          name, version, tilr.name, the scripts below, dev dependencies
build.mjs             optional: import { buildPlugin } from '@tilr-dev/plugin/build'; await buildPlugin({ … })
playwright.config.ts  export { default } from '@tilr-dev/plugin/playwright'
tsconfig.json         { "files": [], "references": [{ "path": "./tsconfig.src.json" }, { "path": "./tsconfig.test.json" }] }
tsconfig.src.json     { "extends": "@tilr-dev/plugin/tsconfig.plugin.json", "include": ["src"] }
tsconfig.test.json    { "extends": "@tilr-dev/plugin/tsconfig.plugin-test.json" }
.oxlintrc.json        { "extends": ["./node_modules/@tilr-dev/plugin/presets/oxlint.json"], "ignorePatterns": [ … ] }
biome.json            { "root": true, "extends": ["@tilr-dev/plugin/biome"] }
lefthook.yml          extends: [node_modules/@tilr-dev/plugin/presets/lefthook.yml]
commitlint.config.js  export { default } from '@tilr-dev/plugin/commitlint'
AGENTS.md, CLAUDE.md  the rules for whoever writes the code (CLAUDE.md is `@AGENTS.md`)
.github/workflows/    ci.yml (the SDK's reusable plugin.yml) and release.yml (release-please)
src/index.ts(x)       the plugin
src/api.ts            optional: the service's types → dist/api.d.ts
test/*.spec.ts        e2e on the harness (@tilr-dev/plugin/test)
src/**/*.test.ts      optional: unit tests (node --test)
```

```json
"scripts": {
  "build": "tilr-plugin build",
  "dev": "tilr-plugin build --watch",
  "dev:site": "tilr-plugin dev",
  "install:site": "tilr-plugin build --install",
  "check": "tilr-plugin verify --only lint,types",
  "test": "npm run test:unit && npm run test:e2e",
  "test:unit": "node --test 'src/**/*.test.ts'",
  "test:e2e": "playwright test",
  "verify": "tilr-plugin verify",
  "verify:full": "tilr-plugin verify --full",
  "prepare": "lefthook install"
}
```

The [template repo](https://github.com/tilr-dev/plugin-template) has all of these, with lefthook
as a dev dependency.

tsconfig.json is a solution: it only points at the two projects, so tsgolint (oxlint's
type-aware rules) and the editor lint each file with its own project, the tests with Node's
types. `tsc -p tsconfig.json` checks nothing; `tilr-plugin verify` checks tsconfig.src.json and
tsconfig.test.json. `extends` in .oxlintrc.json takes the preset's rules, options and overrides
but not its `ignorePatterns`: a repo lists its own (`node_modules/`, `dist/`, `test-results/`,
`playwright-report/`, …).

If a unit test imports the built `dist/index.js`, `test:unit` becomes `tilr-plugin build && node
--import @tilr-dev/plugin/test/node --test 'src/**/*.test.ts'`: the hook resolves `'tilr'`,
`'tilr/ui'`, `'cordis'`, `'react'` … to the package's `site/`, as the page's import map does.

## Writing a plugin

```ts
import { definePlugin } from 'tilr'

export default definePlugin({
  name: 'hello',
  inject: ['ui'],            // services this plugin needs; it waits for them
  apply(ctx) {               // ctx has exactly the injected services, plus ctx.on, ctx.effect …
    const body = ctx.ui.tile({ title: 'hello' })   // a tile that leaves with the plugin
    body.textContent = 'hi'
    ctx.effect(() => {       // anything else that must be undone on unload
      const id = setInterval(() => {}, 1000)
      return () => clearInterval(id)
    })
  },
})
```

- **Import `'tilr'`, not `'@tilr-dev/plugin'`.** In the page `'tilr'` is the import map's entry
  for the running core's `tilr.js` (one cordis, one `Theme` class for every plugin); the build
  leaves it as written. For tsc, `tsconfig.base.json`'s `paths` maps it to `api/tilr.d.ts`.
- **Inject every service you touch**; touch the outside world only through `ctx` (`ctx.effect`,
  `ctx.on`, `ctx.provide`, `ctx.ui.tile`), so that unloading the plugin undoes all of it.
- A service is a class extending cordis' `Service` with `static provide = '<name>'`; its types
  go in `src/api.ts` (`declare module 'tilr' { interface TilrServices { … } }`), which the build
  copies to `dist/api.d.ts`.
- What must survive a reload goes to the store (`inject: ['store']`), not localStorage.
- `version` and `api` may be left out: the build stamps package.json's version and `^` + this
  package's plugin API version, its `tilrApi` (the API the plugin was built against; see Versions). `requires: { counter: '^1.2.0' }`
  checks a provider's version. On a mismatch the plugin is `incompatible`, not started.

## Exports

| import | what it is |
| --- | --- |
| `'@tilr-dev/plugin'` | types only: `api/tilr.d.ts`, the plugin API. A plugin imports `'tilr'`. |
| `'@tilr-dev/plugin/react'`, `/ui`, `/native` | types only: `api/tilr/{react,ui,native}.d.ts`; a plugin imports `'tilr/react'`, `'tilr/ui'`, `'tilr/native'`. The runtime JS is the page's (`site/tilr/*.js`). |
| `'@tilr-dev/plugin/test'` | the e2e harness (`dist/test/harness.js`, from `test/harness.ts`): `serveSite`, `coreSite`, `tilr`, `fakeProvider`, `pluginDir`, `sitePlugins`. |
| `'@tilr-dev/plugin/test/node'` | `node --import` resolve hook: the import map's names → `site/`. |
| `'@tilr-dev/plugin/test/global-setup'` | Playwright globalSetup: `tilr-plugin build` in the plugin's folder. |
| `'@tilr-dev/plugin/build'` | `buildPlugin()` (bundled or not, `api.d.ts`, assets, atomic `dist/`, `--watch`, `--install`), `installPlugin()`. |
| `'@tilr-dev/plugin/playwright'` | the Playwright config (WebKit, `test/`, globalSetup). |
| `'@tilr-dev/plugin/install'` | `installSite()`, `siteDir()`, `pluginName()`: installing into a Tilr site folder. |
| `@tilr-dev/plugin/site/…` | the built core page; `coreSite()` returns its path. |
| `@tilr-dev/plugin/tsconfig.base.json`, `tsconfig.plugin.json`, `tsconfig.plugin-test.json` | compiler settings; a plugin repo's tsconfig.src.json / tsconfig.test.json by `extends` alone. |
| `@tilr-dev/plugin/oxlint` | the lint rules (`presets/oxlint.json`); oxlint's `extends` takes a path: `./node_modules/@tilr-dev/plugin/presets/oxlint.json`. |
| `@tilr-dev/plugin/biome` | the Biome config (format only, linter off): `"extends": ["@tilr-dev/plugin/biome"]`. |
| `@tilr-dev/plugin/lefthook.yml` | the git hooks (`presets/lefthook.yml`); lefthook extends it by path in `node_modules/`. |
| `@tilr-dev/plugin/commitlint` | the commitlint config: Conventional Commits, the standard's types, no AI attribution. |
| `@tilr-dev/plugin/jscpd.json`, `/knip.json` | the defaults `tilr-plugin verify` uses when the repo has no `.jscpd.json` / `knip.json`. |
| `@tilr-dev/plugin/globals` | `__TILR_VERSION__`, `__TILR_API__` (loaded by tsconfig.base.json). |

## CLI

`tilr-plugin`, run in a plugin repo (its npm scripts call it):

| command | what it does |
| --- | --- |
| `tilr-plugin build [--watch] [--install] [--site DIR]` | `node build.mjs …` when the repo has one, else `buildPlugin()` with the defaults |
| `tilr-plugin dev [--site DIR]` | `build --watch --install`: rebuild on every save, install each good build |
| `tilr-plugin init <name> [--force]` | in a fresh copy of the template repo: package.json (`name` `tilr-plugin-<name>`, `tilr.name`, `version` 0.1.0, `repository` / `homepage` / `bugs` from the git `origin`), `const NAME` in `src/index.ts(x)`, a stub README.md, AGENTS.md's "This repo" section; refuses a repo whose `tilr.name` is not the template's `hello` unless `--force` |
| `tilr-plugin install-site [--site DIR]` | `dist/` → `plugins/<name>/` of the Tilr site, the name appended to `plugins.json` |
| `tilr-plugin uninstall-site [--site DIR] [name]` | the reverse: `name` (default: the repo's `tilr.name`) out of `plugins.json`, then `plugins/<name>/` removed; nothing to remove is not an error |
| `tilr-plugin verify [--full] [--skip a,b] [--only a,b]` | the repo standard's checks, in order, stopping at the first failure (Checks & contributing) |
| `tilr-plugin hook pre-commit <files…>` / `hook commit-msg <file>` | what the git hooks run (`presets/lefthook.yml`) |

The site is `--site DIR`, else `$TILR_SITE`, else `site:` in the app's `config.yml`, else
`~/Library/Application Support/dev.tilr.mac/apps/default`. Installing replaces only the plugin's
own folder, merges `plugins.json`, writes atomically and only what changed (the app hot-reloads
it), and refuses a site without the core page. Uninstalling edits `plugins.json` first (the page
stops loading the plugin), then removes the folder; `uninstallSite({ site, names })` in
`@tilr-dev/plugin/install` does the same from code.

The app-control CLI and MCP server (`tilr ctl`, `tilr mcp`, app workspaces) and the bench and
memory tools live outside the SDK; they will become a separate package.

## Testing a plugin

- **Unit**: `node --test 'src/**/*.test.ts'` (Node strips the types). Test helpers in place, as
  named exports; for the built plugin use `--import @tilr-dev/plugin/test/node`.
- **e2e**: Playwright on WebKit (the Mac app's WKWebView engine), `test/*.spec.ts`. No app needed:
  the harness serves the core page from this package with the plugin's `dist/` mounted, and fakes
  of the services it injects:

```ts
import { coreSite, fakeProvider, pluginDir, serveSite, tilr } from '@tilr-dev/plugin/test'

const site = await serveSite({
  site: coreSite(),
  plugins: ['store', 'theme', 'layout', 'counter', 'stats'],
  overlays: {
    stats: './dist',                                     // the plugin under test, built
    counter: await pluginDir(fakeProvider('counter', {   // a service it injects, faked
      version: '1.2.0',
      state: { value: 7 },
      get value() { return this.state.value },
    })),
  },
})
const t = tilr(page)
await t.open(site)
await t.waitForState('stats', 'active')
await t.fake('counter').emit('counter/change', 8)
```

`serveSite` serves on 127.0.0.1 a built core plus plugin folders mounted at `plugins/<name>/`
and a generated `plugins.json`; `mount()`/`unmount()`/`setPluginsJson()` then `t.hmr([...])`
simulate a change on disk. `tilr(page)` has `open`, `list`, `row`, `hmr`, `toggle`, `reload`,
`waitForState`, `tiles`, `consoleErrors` and `fake(name)` (`state`, `set`, `emit`).

## This repo

```text
api/            the plugin API's declarations (committed; the contract)
test/harness.ts the e2e harness → dist/test/ (npm run build)
tools/          build-plugin, tilr-plugin, init-plugin, verify, disable-comments, install-site, paths,
                node-resolve, playwright, global-setup; *.test.mjs are their unit tests
scripts/        sync-runtime.mjs (site/ from web), api-sync.mjs (api/ against web), prepare.mjs (git hooks)
presets/        oxlint, biome, lefthook, commitlint, jscpd, knip: shipped, and used by this repo too
.github/        ci.yml, release.yml (this repo), plugin.yml (the reusable CI of plugin repos)
docs/           plugin-sdk.md, GUIDELINES.md, SDK.md
site/           the core page, copied from web by `npm run sync:runtime` (committed, packed)
```

| script | |
| --- | --- |
| `npm run build` | the harness → `dist/test/` |
| `npm run verify` / `verify:full` | every check (below); `:full` adds `npm pack --dry-run` |
| `npm run check` | the lint and types steps of verify: oxlint and `tsc` (declarations, harness) |
| `npm run format` | `biome format --write .` |
| `npm test` (`test:unit`) | the tools' unit tests (`node --test tools/*.test.mjs`; those that need `site/` are skipped without it) |
| `npm run sync:runtime` | `site/` from web's built `site/` (`-- --build`: build web's page into a temp folder first) |
| `npm run api:check` / `api:sync` | compare `api/` with / refresh it from web's sources |
| `npm run pack:check` | `npm pack --dry-run` (prepack: build, and `site/` must be the page of `tilrApi`) |

### Keeping api/ and site/ in sync

The runtime is web's: `src/tilr.ts`, `src/types.ts`, `src/tilr/*` are the API, `build.mjs`
builds the page. The SDK takes two things from a web checkout (`$TILR_WEB_DIR`, default
`../../../web`), reading it and never writing into it:

- **`api/`** is committed here and is what plugin repos compile against. `npm run api:check`
  emits the declarations with web's `tsconfig.api.json` into a temp folder and fails on any
  difference; `npm run api:sync` copies them in. A diff in `api/` is a change of the contract:
  set `tilrApi` to the API version web implements and commit it as `feat` (`feat!` for anything
  that breaks a plugin built against the old one), so release-please bumps the package too.
- **`site/`** (the page, its built-in plugins, `tilr.js`, `tilr/{react,ui,native}.js`, the vendored
  cordis and React) is committed and is copied by `npm run sync:runtime`, which requires the
  plugin API web implements (web's package.json version, which its build reports as
  `window.tilr.api`) to equal `tilrApi`: a plugin stamped `^<tilrApi>` must run on it. It records
  the API, web's version and commit in `site/.sync.json`; `--check` (and prepack) fail unless
  that API is `tilrApi`. Refresh it on purpose, in a PR of its own.

### Versions

Three versions, each moving on its own:

| version | where | changes |
| --- | --- | --- |
| SDK package | package.json `version` | release-please, from the Conventional Commits (any fix of the tools, presets or harness) |
| plugin API | package.json `tilrApi` | only when the `api/` contract changes, together with `npm run api:sync` (and `sync:runtime`); release-please never touches it |
| web (core) | web's package.json | independently, in the core repo; today it is also the API its page reports |

`tilr-plugin build` stamps a plugin `api: ^<tilrApi>` of the installed SDK (its `version` for an
SDK from before `tilrApi`), so a new SDK release with the same API leaves plugins' stamps as they
were.

### Releasing

release-please (`.github/workflows/release.yml`) keeps a release PR open from the Conventional
Commits on main (version bump in package.json and the manifest, CHANGELOG entry; while 0.x
`feat` and breaking changes bump the minor, `fix` the patch). It bumps only `version`, never
`tilrApi` (Versions). Merging it tags `vX.Y.Z` and creates the GitHub release; then the
`publish` job of the same workflow checks out the tag, runs `verify --full --skip api` and
`npm publish --provenance --access public`. The `npm` environment only admits `main` and has no
required reviewer: merging the release PR is the approval.

Publishing uses npm trusted publishing (OIDC: no token; provenance links the tarball to the
run). npm's trusted publisher for the package is bound to repository `tilr-dev/plugin-sdk`,
workflow file `release.yml`, environment `npm`. It needs no web checkout: `site/` is committed,
and `api:check` (web's sources) is run locally whenever `api/` or `site/` is synced.

The release-please job acts as the org GitHub App `tilr-bot` (a short-lived installation token,
`TILR_BOT_CLIENT_ID` / `TILR_BOT_PRIVATE_KEY`), so the release PR is opened by tilr-bot and CI
runs on it like on any other PR: it is merged through the same required checks, with no bypass.

## Checks & contributing

The repo standard (one source of truth for the SDK and every plugin repo): **`npm run verify`**
is what a human, the git hooks and CI run, so green locally means green in CI. It is
`tilr-plugin verify` (`tools/verify.mjs`), the same command a plugin repo runs:

| step | tool | what it catches |
| --- | --- | --- |
| format | Biome, `biome format` (format only) | style; `npm run format` fixes it |
| lint | oxlint, type-aware through oxlint-tsgolint (`presets/oxlint.json`), then `tools/disable-comments.mjs` | `any`, `!`, unexplained ts-ignore, dropped promises, complexity > 15, depth > 4, params > 4, unused disables, disables without the rule or a ` -- reason`, whole-file disables (a range disable without its enable); warnings: file length, magic numbers |
| types | `tsc --noEmit -p` (tsconfig.src.json, tsconfig.test.json) | types |
| api | `npm run api:check` (when the repo has it) | an unnoticed change of the public contract |
| unit | `npm run test:unit` | logic |
| dupes | jscpd (`presets/jscpd.json` or `.jscpd.json`) | copy-paste between files |
| unused | knip (`knip.json`, else `presets/knip.json`) | unused files, exports, dependencies |
| secrets | gitleaks (`.gitleaks.toml` for exceptions) | keys, tokens, in the git history |
| deps | `npm audit --audit-level=high` | vulnerable dependencies |

`verify:full` adds `test:e2e` (Playwright WebKit) and `npm pack --dry-run` (unless private).
The first failure stops the run. `--no-runtime` (or `TILR_NO_RUNTIME=1`) skips the steps that
need the core page or a web checkout (api, e2e, pack: "skipped: needs core page (web)"); the
SDK's CI has `site/` committed and skips only `api` (`--skip api`). gitleaks is a Go binary, not on npm: put it on `PATH`
(`brew install gitleaks`) or set `$GITLEAKS`; without it the step fails on CI (`$CI`) and
is a warning locally. `--skip deps` is for working offline.

Git hooks (lefthook, installed by `npm install` through `prepare`; only in a git checkout,
never when the package is installed as a dependency): **pre-commit** formats and lints the
staged files and runs gitleaks on the staged diff; **commit-msg** runs commitlint
(Conventional Commits: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`; no AI
attribution lines); **pre-push** runs `npm run verify`.

CI (`.github/workflows/`): `ci.yml` runs `verify --full --skip api` on Node 22 and 24 on
every pull request and push to main (everything, with the unit tests that need `site/` and
`npm pack --dry-run`, but `api:check`, which needs web's sources); `plugin.yml` is
`verify:full` for plugin repos (`uses: tilr-dev/plugin-sdk/.github/workflows/plugin.yml@v0`,
input `node-version`; the SDK comes from npm with `site/` in it); `release.yml` is
release-please and the npm publish of each release (Releasing). Workflows have minimal
`permissions`, no `pull_request_target`, and actions pinned by commit SHA. Dependabot
(`.github/dependabot.yml`) updates the actions and the npm dependencies weekly, `typescript`,
`oxlint` and `oxlint-tsgolint` in one group of their own.

Contributing: read [AGENTS.md](AGENTS.md). Short branches, Conventional Commits, PRs
squash-merged into a green `main`; `npm run verify` before every commit.

## License

MIT OR Apache-2.0, at your option: [LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE).
