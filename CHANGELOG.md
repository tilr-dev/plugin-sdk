# Changelog

The versions of `@tilr-dev/plugin`, which are the versions of the plugin API: what `api: '^0.1.0'`
in a plugin refers to. The contract is `api/` (README, Keeping api/ and site/ in sync). While
the version is 0.x, a minor bump may break plugins (`^0.1.0` accepts 0.1.x only). Entries before
0.1.14 are in the core repo's (web/) CHANGELOG, where the package used to live.

## Unreleased

Removed: the `tilr` bin (`ctl`, `mcp`, app/plugin workspace commands), bench, memory, browser
tools — not part of the plugin SDK. The SDK keeps what a plugin author needs (`tilr-plugin`).

The repo standard (one pipeline for the SDK and every plugin repo):

- `tilr-plugin verify [--full]`: format (Biome, format only), lint, types, api, unit, dupes
  (jscpd), unused (knip), secrets (gitleaks), deps (`npm audit --audit-level=high`); `--full`
  adds e2e and `npm pack --dry-run`. The first failure stops it. `tilr-plugin hook pre-commit |
  commit-msg` for the git hooks.
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
  (`ci.yml`, the reusable `plugin.yml`, `release.yml` with release-please and npm provenance),
  Renovate, AGENTS.md.

## 0.1.14 — unreleased

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
