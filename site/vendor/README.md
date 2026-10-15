# vendor

Browser builds of the plugin runtime (MIT, see LICENSE). The JS files are not in the repo:
`build.mjs` copies them from the installed packages into `site/vendor/`, so the runtime the page
runs and the types `npm run check` uses are the same version.

- `cordis.js` ← `node_modules/cordis/lib/index.js`: `@deepseek-ai/cordis` 4.0.1, installed under
  the alias `cordis` so that `import { Service } from 'cordis'` resolves the same in TypeScript
  and in the browser
- `cosmokit.js` ← `node_modules/@deepseek-ai/cosmokit/lib/index.js`: `@deepseek-ai/cosmokit`
  1.8.2, its only runtime dependency

Both `lib/index.js` files are plain ESM with no Node APIs; the only import is cordis' bare
`@deepseek-ai/cosmokit`, which the import map in `index.html` maps here. 4.0.1 / 1.8.2 are
byte-identical to the files that used to be vendored here (from
`deepseek-harness/vendor/cordis`, commit 99f6f02fec, 2026-08-17).

To update: bump both exact versions in `package.json` (cordis' `dependencies` says which
cosmokit it wants; keep a single copy installed), `npm install`, `npm run check`, `npm run build`.
