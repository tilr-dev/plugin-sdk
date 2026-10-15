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
// On top of the recommended sets (the repo standard, §3): a disable needs a description and an
// unused one is an error; complexity ≤ 15, depth ≤ 4, params ≤ 4 (errors); file length and
// magic numbers (warnings: a nudge, not a gate); no console in a plugin's src/ (tests, tools and
// Node scripts may log).
//
// Needs eslint, @eslint/js and typescript-eslint installed next to it (optional peers);
// @eslint-community/eslint-plugin-eslint-comments is a dependency of this package.
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const TESTS = ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.ts', 'playwright.config.ts']
/** Tests of any kind, .ts or Node .mjs: exempt from the size and magic-number nudges. */
const ANY_TESTS = [...TESTS, '**/*.test.mjs', '**/*.test.js', '**/*.spec.ts', 'test/**/*.mjs']
/** 0, 1 and -1 are never magic (an empty length, the next index, "not found"). */
const MAGIC = {
  ignore: [0, 1, -1],
  ignoreArrayIndexes: true,
  ignoreDefaultValues: true,
  ignoreClassFieldInitialValues: true,
}

const config = [
  { ignores: ['node_modules/', 'site/', 'api/', 'dist/', 'test-results/', 'playwright-report/'] },
  // A `// eslint-disable…` that no longer suppresses anything is an error, not a leftover.
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  comments.recommended,
  {
    rules: {
      // Turning a rule off says why: `// eslint-disable-next-line rule -- the reason`.
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-magic-numbers': ['warn', MAGIC],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      // Type-aware: a promise nobody handles, or one handed to a DOM handler that ignores it.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          'ts-nocheck': true,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // What a module exports is the plugin API: its types are written down, not inferred.
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      // The TypeScript-aware variant: enums, numeric literal types and type indexes are not magic.
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-magic-numbers': [
        'warn',
        {
          ...MAGIC,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
        },
      ],
    },
  },
  {
    // A plugin reports through the page (ctx, the store, a tile), not the console.
    files: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js', 'src/**/*.mjs'],
    ignores: TESTS,
    rules: { 'no-console': 'error' },
  },
  {
    // The tests are in tsconfig.test.json (Node's types), not in the tsconfig.json that the
    // project service would find for them.
    files: TESTS,
    languageOptions: { parserOptions: { projectService: false, project: './tsconfig.test.json' } },
    rules: {
      // node:test's test() and describe() return promises the runner itself awaits.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it'] }],
        },
      ],
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
    // Tests spell out their fixtures: numbers and long files are what they are.
    files: ANY_TESTS,
    rules: { 'max-lines': 'off', 'no-magic-numbers': 'off', '@typescript-eslint/no-magic-numbers': 'off' },
  },
  {
    // Build scripts, eslint.config.js, scripts/ and test helpers run in Node.
    files: ['*.js', '*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', 'tools/**/*.js', 'tools/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
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
