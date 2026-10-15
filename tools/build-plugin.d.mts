// The types of tools/build-plugin.mjs (`@tilr-dev/plugin/build`); what it does is in its header.
import type { BuildOptions, BuildResult as EsbuildResult } from 'esbuild'

/** The bare names the page's import map resolves: never bundled, the only imports a
 *  `bundle: false` build allows. */
export declare const IMPORT_MAP: readonly string[]
/** The extensions copied from src/ to dist/ by default. */
export declare const ASSETS: readonly string[]
/** The name of the export the build appends to dist/index.js (`{ version, api }`). */
export declare const STAMP: '__tilrBuild'

/** What the `esbuild` function and the hooks get: this build. */
export interface PluginBuildContext {
  /** The plugin repo (absolute). */
  root: string
  /** The temp folder this build writes to; it becomes dist/ when the build is complete. */
  out: string
  /** dist/ (absolute): where the files end up, what esbuild's paths are relative to. */
  dist: string
  /** package.json's version (`__TILR_VERSION__`). */
  version: string
  /** The @tilr-dev/plugin version built against (`__TILR_API__`; the stamped `api` is `^` + it). */
  api: string
  /** The plugin's name in the site (package.json `tilr.name`, else the package name). */
  name: string
  /** The entry, relative to `root`. */
  entry: string
  bundle: boolean
  watching: boolean
  argv: string[]
}

export interface PluginBuildAfterContext extends PluginBuildContext {
  /** esbuild's result of the main build (null for `bundle: false`). */
  result: EsbuildResult | null
  /** The dist paths written to `out` so far. */
  files: string[]
}

export interface BuildPluginOptions {
  /** The plugin repo; default the current directory. */
  root?: string
  /** Default src/index.tsx, else src/index.ts. Its output is dist/index.js. */
  entry?: string
  /** Default true: bundle what the entry imports, the import map's names external. false: the
   *  entry alone, types stripped; an import outside the import map fails the build. */
  bundle?: boolean
  /** The service's types, copied to dist/api.d.ts. Default src/api.ts when it exists; false: none. */
  api?: string | false
  /** Extensions copied from the entry's folder to dist/ at the same relative path. Default ASSETS. */
  assets?: readonly string[]
  /** More files: dist path → source path relative to `root` (`{ 'onig.wasm': 'node_modules/shiki/dist/onig.wasm' }`). */
  copy?: Record<string, string>
  /** More esbuild `define`s (values are code: `JSON.stringify('x')`, `'undefined'`). */
  define?: Record<string, string>
  /** More esbuild options, or a function of the build that returns them (run once per build,
   *  before the main build). `define`, `loader`, `alias` merge with the shared ones, `plugins`
   *  append, everything else replaces (`external`: the import map by default; `minify`;
   *  `entryPoints`, which must keep one named `index`). With `bundle: false` only the options
   *  of esbuild.transform are allowed. */
  esbuild?: BuildOptions | ((build: PluginBuildContext) => BuildOptions | Promise<BuildOptions>)
  hooks?: {
    /** After the main build, before dist/ is replaced: write more outputs into `out`. A throw
     *  fails the build (dist/ keeps the last good one). */
    after?(build: PluginBuildAfterContext): void | Promise<void>
  }
  /** Default process.argv.slice(2): `--watch`, `--install`, `--site DIR`. */
  argv?: string[]
}

export interface BuildPluginResult {
  /** The last build succeeded (and installed, with --install and no --watch). */
  readonly ok: boolean
  /** The dist paths of the last good build. */
  readonly files: string[]
  /** Stops a --watch (nothing to stop otherwise). */
  close(): void
}

/** Builds the plugin into dist/; with --watch keeps rebuilding, with --install installs after
 *  each good build. Without --watch a failure sets `process.exitCode = 1`. */
export declare function buildPlugin(options?: BuildPluginOptions): Promise<BuildPluginResult>
/** Installs the plugin's dist/ into the Tilr site (--site DIR, $TILR_SITE, the app's config,
 *  the default); resolves to the changed site paths. */
export declare function installPlugin(options?: { root?: string, argv?: string[] }): Promise<string[]>
/** Throws a readable error unless `version` (default this Node) meets `range` (package.json's engines). */
export declare function checkNode(version?: string, range?: string): void
/** The version of @tilr-dev/plugin installed for the plugin at `root`, else this package's. */
export declare function apiVersion(root?: string): string
/** `code` with the build stamp appended before a trailing sourceMappingURL comment. Throws if
 *  `code` has a `__tilrBuild` already. */
export declare function stamp(code: string, versions: { version: string, api: string }): string
