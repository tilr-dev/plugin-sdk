// The types of tools/install-site.js (`@tilr-dev/plugin/install`); the rules are in its header.

/** <config>/apps/default, the Mac app's default site folder. */
export declare const DEFAULT_SITE: string
/** `site:` in the selected config folder’s config.yml, `~` expanded; null without the file or the key. */
export declare function configSite(file?: string): string | null
/** --site DIR, $TILR_SITE, the app's config, <config>/apps/default; in that order. */
export declare function siteDir(argv?: string[], env?: Record<string, string | undefined>): string
/** What a plugin name may be: a folder name under plugins/, safe in a URL and a CSS class. */
export declare const PLUGIN_NAME: RegExp
/** package.json's `tilr.name`, or the package name without scope and `plugin-` prefix. */
export declare function pluginName(pkg: { name: string; tilr?: { name?: string } }): string
export interface InstallOptions {
  site: string
  /** Copied to the site's top level, except plugins/ and plugins.json. Nothing there is removed. */
  root?: string | null
  /** name → folder, each mirrored to plugins/<name>/. */
  plugins?: Record<string, string>
  /** Names appended to plugins.json when missing (default: the keys of `plugins`). */
  list?: string[]
}
/** Resolves to the changed site paths (`-path` for a removal); empty when nothing differed. */
export declare function installSite(options: InstallOptions): Promise<string[]>
export interface UninstallOptions {
  site: string
  /** The plugins to remove: from plugins.json first, then their plugins/<name>/ folders. */
  names: string[]
}
/** Resolves to the changed site paths (`-plugins/<name>` for a removed folder); empty when none was there. */
export declare function uninstallSite(options: UninstallOptions): Promise<string[]>
