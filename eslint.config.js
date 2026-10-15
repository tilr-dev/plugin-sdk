// The core lints itself with the config it ships to plugin repos (eslint.base.js,
// `@tilr-dev/plugin/eslint`), pointed at its own tsconfigs.
import { withRoot } from './eslint.base.js'

export default withRoot(import.meta.dirname)
