// The core lints itself with the config it ships to plugin repos (eslint.base.js,
// `@tilr-dev/plugin/eslint`), pointed at its own tsconfigs. templates/ is a plugin repo's files,
// linted there (its eslint.config.js imports the published package).
import { withRoot } from './eslint.base.js'

export default [{ ignores: ['templates/'] }, ...withRoot(import.meta.dirname)]
