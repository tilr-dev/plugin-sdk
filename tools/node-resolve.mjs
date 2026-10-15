// @tilr-dev/plugin/test/node: `node --import @tilr-dev/plugin/test/node --test …` lets a plugin's
// unit test import its built dist/index.js under Node. The build leaves the import map's names
// ('tilr', 'tilr/ui', 'cordis', 'react', … : IMPORT_MAP in build-plugin.mjs) as bare imports for
// the page to resolve; Node cannot, so this resolve hook maps each to the file the page's import
// map (static/index.html) points at, in this package's built site/: the real modules, not fakes,
// one copy of each (cordis, React) for the plugin and the test alike. Each of them imports without a
// DOM (none touches document/window/customElements at the top level); what a plugin then calls
// that needs one is the test's to stub. site/ ships with the package (`files`); in an SDK
// checkout `npm run sync:runtime` copies it from the core repo (web/).
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const SITE = new URL('../site/', import.meta.url)

/** Specifier → path under site/, as static/index.html's import map has it. */
export const SITE_FILES = {
  'cordis': 'vendor/cordis.js',
  '@deepseek-ai/cosmokit': 'vendor/cosmokit.js',
  'tilr': 'tilr.js',
  'tilr/react': 'tilr/react.js',
  'tilr/ui': 'tilr/ui.js',
  'tilr/native': 'tilr/native.js',
  'react': 'vendor/react.js',
  'react/jsx-runtime': 'vendor/react-jsx-runtime.js',
  'react-dom': 'vendor/react-dom.js',
  'react-dom/client': 'vendor/react-dom.js',
}

const missing = [...new Set(Object.values(SITE_FILES))].filter(path => !existsSync(new URL(path, SITE)))
if (missing.length) {
  throw new Error(`@tilr-dev/plugin/test/node: ${fileURLToPath(SITE)} has no ${missing.join(', ')}: `
    + `the SDK's site/ is not built. Run \`npm run sync:runtime\` in @tilr-dev/plugin (${fileURLToPath(new URL('..', SITE))}).`)
}

registerHooks({
  resolve(specifier, context, next) {
    const path = Object.hasOwn(SITE_FILES, specifier) ? SITE_FILES[specifier] : undefined
    return path ? { url: new URL(path, SITE).href, shortCircuit: true } : next(specifier, context)
  },
})
