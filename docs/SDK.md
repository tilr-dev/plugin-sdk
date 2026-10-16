# Shared plugin SDK proposal

> **Status: implemented (stage 1, `@tilr-dev/plugin` 0.1.14).** What was built, and how to use it:
> [plugin-sdk.md](plugin-sdk.md). The pieces: `@tilr-dev/plugin/build` (`tools/build-plugin.mjs`),
> `@tilr-dev/plugin/playwright` and `/test/global-setup` (`tools/playwright.mjs`,
> `tools/global-setup.mjs`), `tsconfig.plugin.json` / `tsconfig.plugin-test.json`, the oxlint
> preset `@tilr-dev/plugin/oxlint`, the `tilr-plugin` bin (`tools/tilr-plugin.mjs`), and the runtime
> helpers `frame()` / `element()` (`tilr/ui`), `onLayout()` / `optional()` (`tilr`),
> `connectNative()` (`tilr/native`). Not done yet: the multi-repository verification runner and
> the versioned core fixture (steps 5 below); the plugins' migration (steps 2-4) is stage 3.
> The text below is the proposal as written.

Extend the existing `@tilr-dev/plugin` package with shared build and verification tooling.
The package already supplies API types, TypeScript and lint configuration, the installer
and the test harness. The next step is to move repeated build/watch/asset logic out of
individual plugins while retaining their independent repositories.

This was the proposed design; see the status note above for what exists now.

## Problem and intended result

The plugins carry similar `build.mjs`, watch loops, asset copying and setup scripts. Some
leave imports for the host's import map, others bundle their sources, and Editor adds
workers, WASM and lazy grammars. Fixes to common behavior must currently be copied between
repositories; Menu's missing API declaration output is one example of that drift.

A plugin should describe its entry point, bundling mode and extra assets in a small local
config. The SDK should consistently build, watch and install it. Service implementations,
window code and wire protocols stay in their own repositories.

## Package boundaries

| Existing or proposed surface | Responsibility |
| --- | --- |
| Existing types and runtime imports | Contracts and shared host runtime; retain current import compatibility |
| Existing `/install` | Site resolution and atomic installation |
| Existing `/test` | Core harness, fake providers and plugin fixtures |
| Proposed `/build` | Entry discovery, esbuild options, assets, API declarations and watch orchestration |
| Proposed verification command | Node version check, type/lint/unit/build/E2E execution and clear failure reporting |

Start in the existing package in `web`. Do not require an npm workspace or a new monorepo
to adopt the tooling. A separate CLI package can follow if its release cadence or
dependencies justify the split. A published SDK should eventually let a plugin build from
its own checkout without a sibling `web` source tree; E2E also needs a versioned core fixture.

## Proposed build contract

For example, a plugin's `build.mjs` could become:

```js
import { buildPlugin } from '@tilr-dev/plugin/build'

await buildPlugin({
  entry: 'src/index.ts',
  bundle: true,
  api: 'src/api.ts',
  assets: ['src/**/*.css', 'src/**/*.svg'],
  argv: process.argv.slice(2),
})
```

The helper would read package name/version and apply the shared browser target and
external imports. It would support the existing `--watch`, `--install` and `--site`
workflow. Template could select non-bundled output; Editor could provide hooks for its
worker, WASM and grammar outputs. Unsupported source imports in non-bundled mode should
fail clearly instead of producing an install that later returns 404.

Build into a temporary output directory and replace `dist/` only after every required
output is ready. Keep installation in the existing installer, including its asset-first
ordering. Generate or copy public declarations consistently and validate their referenced
types; do not silently bundle another copy of the host runtime.

Watch should serialize builds, debounce bursts and catch installation failures. Changes
to version/config and assets must trigger the appropriate rebuild, not just edits to the
entry source.

## Verification across independent repositories

Keep per-plugin `check`, `test:unit`, `test:e2e` and `build` commands usable independently.
A shared runner should check the actual Node executable used by child commands and report
unsupported versions before running tests.

For the local plugin set, an optional manifest can list repository paths and build
dependencies. A runner can then build the core fixture and providers before consumers,
followed by requested checks. Runtime optional integrations and test dependencies are
different: Files tests can require a server fixture even when another integration is optional.
Do not infer every test dependency solely from runtime `inject` or `requires`.

Classify type/lint errors, build failures, test assertion failures and environment failures
separately. A denied localhost listener or failed browser launch is not a passing E2E run.
Native behavior still needs an app check; the runner cannot replace it with an iframe test.

## Adoption steps

1. Extract common build behavior into `/build`, with fixtures for bundled and non-bundled
   plugins, declaration output, assets, failure recovery and serialized watch builds.
2. Migrate Template and Menu first. Preserve their installed artifact shape and existing
   commands; use them to validate the smallest configurations.
3. Migrate Browser, Terminal, Files, Panes, Tabs, Server and Webamp. Keep their third-party
   dependencies, sourcemaps and generated protocol inputs explicit.
4. Migrate Editor after defining hooks for workers, WASM and split grammars. Compare output
   and verify lazy loading and reload cleanup.
5. Add the optional multi-repository verification runner and a versioned core test fixture.
   Publish only after a standalone plugin can build and test against the selected SDK version.

Accept the migration when all plugins retain their runtime behavior, output contracts and
installation workflow; compilation failure preserves the last good build; tests consume
fresh provider output; and a common build fix needs one SDK change.

## Work that remains separate

Atomic file conflict prevention belongs in the server protocol. Connection recovery and
pane subscription ownership belong in the Server service. Native proxy routing belongs
in the host. The SDK should make these components easier to build and test without moving
their product behavior into generic tooling.
