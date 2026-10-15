// The shared lint config, shipped as `@tilr-dev/plugin/eslint`: the guards that keep plugins
// honest (no `any`, no `!`, no silent @ts-ignore, no dropped promises). Type errors themselves are
// `tsc --noEmit`'s. A flat-config array for the layout the core and the plugin template share:
// sources under src/ (tsconfig.json, found by the project service), tests in test/ and
// src/**/*.test.ts plus playwright.config.ts (tsconfig.test.json, with Node's types), Node scripts
// as .js/.mjs. A plugin repo's eslint.config.js, with where its tsconfigs are (.ts and .tsx):
//
//   import { withRoot } from '@tilr-dev/plugin/eslint'
//   export default withRoot(import.meta.dirname)
//
// The default export is the array without a root (`[...tilr, …]` to extend it; typescript-eslint
// then takes the current directory, which is the repo's when eslint runs from an npm script).
//
// Needs eslint, @eslint/js and typescript-eslint installed next to it (optional peers).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const TESTS = ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.ts', 'playwright.config.ts']

const config = [
  { ignores: ['node_modules/', 'site/', 'api/', 'dist/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      // Type-aware: a promise nobody handles, or one handed to a DOM handler that ignores it.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore': 'allow-with-description',
        'ts-expect-error': 'allow-with-description',
        'ts-nocheck': true,
        minimumDescriptionLength: 10,
      }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // What a module exports is the plugin API: its types are written down, not inferred.
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    // The tests are in tsconfig.test.json (Node's types), not in the tsconfig.json that the
    // project service would find for them.
    files: TESTS,
    languageOptions: { parserOptions: { projectService: false, project: './tsconfig.test.json' } },
    rules: {
      // node:test's test() and describe() return promises the runner itself awaits.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it'] }],
      }],
    },
  },
  {
    rules: {
      // The house style: `try { localStorage… } catch {}` and `cond ? a() : b()` as statements.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  {
    // Build scripts, eslint.config.js, scripts/ and test helpers run in Node.
    files: ['*.js', '*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', 'tools/**/*.js', 'tools/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
      },
    },
  },
]

export default config

/** The config with the tsconfigs found from `root` (the repo's folder: `import.meta.dirname`),
 *  for .ts and .tsx alike. */
export function withRoot(root) {
  return [...config, { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parserOptions: { tsconfigRootDir: root } } }]
}
