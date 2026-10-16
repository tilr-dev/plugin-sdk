# Changelog

The versions of `@tilr-dev/plugin`, which are the versions of the plugin API: what `api: '^0.1.0'`
in a plugin refers to. The contract is `api/` (README, Keeping api/ and site/ in sync). While
the version is 0.x, a minor bump may break plugins (`^0.1.0` accepts 0.1.x only). Entries before
0.1.14 are in the core repo's (web/) CHANGELOG, where the package used to live.

## [0.2.0](https://github.com/tilr-dev/plugin-sdk/compare/v0.1.16...v0.2.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* @tilr-dev/plugin/eslint (eslint.base.js) is gone. A plugin repo replaces eslint.config.js with an .oxlintrc.json that extends ./node_modules/@tilr-dev/plugin/presets/oxlint.json and lists its own ignorePatterns, swaps eslint, @eslint/js and typescript-eslint for oxlint and oxlint-tsgolint, moves to typescript 7, and switches to the solution tsconfig layout: tsconfig.json → tsconfig.src.json + tsconfig.test.json.
* the package no longer ships templates/plugin/. Start a plugin from https://github.com/tilr-dev/plugin-template and run tilr-plugin init.

### Features

* tilr-plugin init and uninstall-site ([#7](https://github.com/tilr-dev/plugin-sdk/issues/7)) ([d96f7ea](https://github.com/tilr-dev/plugin-sdk/commit/d96f7eaa40e2c8a668594b07bde0e2b27036cba7))
* TypeScript 7 and oxlint instead of ESLint ([#9](https://github.com/tilr-dev/plugin-sdk/issues/9)) ([99d49cc](https://github.com/tilr-dev/plugin-sdk/commit/99d49cc5e84bf50694d80903fd6a6ddc04683f30))

## [0.1.16](https://github.com/tilr-dev/plugin-sdk/compare/v0.1.15...v0.1.16) (2026-10-15)


### Bug Fixes

* **test:** expect the tilrApi stamp, not the package version ([#4](https://github.com/tilr-dev/plugin-sdk/issues/4)) ([b02d094](https://github.com/tilr-dev/plugin-sdk/commit/b02d09404d3d4c87ee1716481f620c8ae00fea3e))

## [0.1.15](https://github.com/tilr-dev/plugin-sdk/compare/v0.1.14...v0.1.15) (2026-10-15)


### Bug Fixes

* add repository, homepage, bugs and keywords to package.json ([#1](https://github.com/tilr-dev/plugin-sdk/issues/1)) ([fd18485](https://github.com/tilr-dev/plugin-sdk/commit/fd184851257e8d1f1cd2380e81d826ce30a0ef06))
* publish releases from CI; separate tilrApi from the package version ([#3](https://github.com/tilr-dev/plugin-sdk/issues/3)) ([c658e0a](https://github.com/tilr-dev/plugin-sdk/commit/c658e0ae25efa38900acc9d748461e7cad5d974c))

## 0.1.14

First release from this repo.

Removed: the `tilr` bin (`ctl`, `mcp`, app/plugin workspace commands), bench, memory, browser
tools — not part of the plugin SDK. The SDK keeps what a plugin author needs (`tilr-plugin`).

The repo standard (one pipeline for the SDK and every plugin repo):

- `tilr-plugin verify [--full]`: format (Biome, format only), lint, types, api, unit, dupes
  (jscpd), unused (knip), secrets (gitleaks), deps (`npm audit --audit-level=high`); `--full`
  adds e2e and `npm pack --dry-run`. The first failure stops it. `tilr-plugin hook pre-commit |
  commit-msg` for the git hooks.
- `tilr-plugin verify --no-runtime` (or `TILR_NO_RUNTIME=1`) skips the steps that need the core
  page or a web checkout (api, e2e, pack). The SDK's CI runs so until web is on GitHub; npm
  publishing is manual meanwhile (README, Releasing).
- Shipped presets: `@tilr-dev/plugin/biome`, `/lefthook.yml`, `/commitlint` (Conventional
  Commits, no AI attribution), `/jscpd.json`, `/knip.json`; `templates/plugin/` with the files a
  plugin repo has (AGENTS.md, CLAUDE.md, configs, CI and release workflows).
- `@tilr-dev/plugin/eslint` is stricter, so a plugin may get new findings: a disable needs a
  description (`-- why`) and an unused one is an error; `complexity` ≤ 15, `max-depth` ≤ 4,
  `max-params` ≤ 4 (errors); `max-lines` (400) and `no-magic-numbers` (warnings, not in tests);
  `no-console` in `src/` (not in tests and tools).
- New dependencies (the checks' tools): `@biomejs/biome`, `@commitlint/cli`,
  `@commitlint/config-conventional`, `conventional-changelog-conventionalcommits`,
  `@eslint-community/eslint-plugin-eslint-comments`, `jscpd`, `knip`. `lefthook` is an optional
  peer (a plugin repo adds it as a dev dependency).
- This repo: formatted with Biome; `npm run verify` / `verify:full`, lefthook hooks, CI
  (`ci.yml`, the reusable `plugin.yml`, `release.yml` with release-please; npm publish is manual for now),
  Renovate, AGENTS.md.

The SDK moves to its own repo (this one), extracted from the core repo (web/) without history.
The package's contents and exports are those of web's 0.1.14; what changed is where they come from:

- `api/` is committed here as the source of truth for plugin repos; `npm run api:check` /
  `api:sync` compare it with (and refresh it from) the declarations web's sources emit.
- `site/`, the built core page the harness serves and `@tilr-dev/plugin/test/node` resolves to,
  is copied from web by `npm run sync:runtime` (gitignored, packed). `prepack` refuses a
  tarball without it, or with a page of another version.
- `tilr` and `addSitePlugins` read the core plugin list from the kit's `static/plugins.json`
  (a web checkout) or, failing that, `site/plugins.json` (this package): `corePlugins()` in
  `tools/paths.js`.
- Left in web, not shipped any more: `tools/performance-exporter.mjs`,
  `tools/publish-workspace.mjs` (core/app tools, not the plugin kit).

From web's 0.1.14 entry, the SDK itself (docs/plugin-sdk.md). Additions only: a patch while 0.x,
so installed plugins with `api: '^0.1.x'` keep running; a plugin that uses the new helpers is
built against 0.1.14 and stamped `api: '^0.1.14'`.

- `'tilr/ui'`: `frame(win, { className, title, controls })` → `{ tile, header, controls, body,
  dispose }`, the standard frame without React; `element(tag, className, text)`;
  `frameControls(win)` and `FRAME`.
- `'tilr'`: `onLayout(ctx, listener, { ignore })`; `optional(ctx, services, apply)`; the types
  `LayoutChange`, `LayoutChangeKind`.
- `'tilr/native'` (new import map entry): `connectNative()`, `hasNative()`, `nativeChannel()`;
  the `webkit` global's type.
- `version` / `api` defaults: a plugin built by `@tilr-dev/plugin/build` may leave them out; the
  build's stamp (`__tilrBuild`) supplies package.json's version and `^` + the SDK version.
- `__TILR_API__` in `globals.d.ts` (shipped): the SDK version the code is built with.
- Kit, not API: `@tilr-dev/plugin/build` (`buildPlugin`, `installPlugin`),
  `@tilr-dev/plugin/playwright`, `@tilr-dev/plugin/test/global-setup`, `tsconfig.plugin.json`,
  `tsconfig.plugin-test.json`, `withRoot()` in `@tilr-dev/plugin/eslint`, the `tilr-plugin` bin;
  `esbuild` an optional peer.
- `@tilr-dev/plugin/test/node`: resolves the import map's names to the package's site/, so a
  unit test can import the built `dist/index.js`.
