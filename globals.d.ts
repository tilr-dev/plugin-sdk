// The build constant a plugin declares its version with: `version: __TILR_VERSION__` (`static
// version = __TILR_VERSION__` on a class). Whoever builds the plugin replaces it with a string
// literal (esbuild `define`): a plugin repo's build with its own package.json's version, the
// core's build.mjs with the core's. tsconfig.base.json loads this file, so a plugin repo that
// extends it declares nothing. Not part of the plugin API: api/ never sees this file.
declare const __TILR_VERSION__: string
// `__TILR_API__`: the version of @tilr-dev/plugin the code was built with, i.e. the plugin API
// it was built against. A plugin repo's build (`@tilr-dev/plugin/build`) defines it from the
// installed package (node_modules/@tilr-dev/plugin/package.json) and stamps `api: '^' +
// __TILR_API__` onto a plugin that declares no `api`; the core's build.mjs defines it from its
// own package.json, the API the page implements (`window.tilr.api`).
declare const __TILR_API__: string
