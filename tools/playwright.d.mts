// The types of tools/playwright.mjs (`@tilr-dev/plugin/playwright`).
import type { PlaywrightTestConfig } from '@playwright/test'

/** The plugin repo's Playwright config: test/, WebKit, headless, the build as globalSetup. */
declare const config: PlaywrightTestConfig
export default config
