// `@tilr-dev/plugin/playwright`: the Playwright config of every plugin repo. Its
// playwright.config.ts is one line:
//
//   export { default } from '@tilr-dev/plugin/playwright'
//
// e2e on WebKit (Desktop Safari), the engine of the Mac app's WKWebView: test/*.spec.ts, headless,
// no retries, the list reporter; globalSetup builds the plugin first (tools/global-setup.mjs).
// One-time setup on a new machine: `npx playwright install webkit`. To change something, spread
// it: `import config from '@tilr-dev/plugin/playwright'; export default { ...config, timeout: 60_000 }`.
//
// @playwright/test is the plugin's own copy (resolved from the current directory, where
// `playwright test` runs), not one next to this file: with the package linked (`file:`) this
// file's would be the core repo's, and Playwright refuses to load two.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function playwright() {
  let module
  try {
    const require = createRequire(join(process.cwd(), 'package.json'))
    module = await import(pathToFileURL(require.resolve('@playwright/test')).href)
  } catch {
    module = await import('@playwright/test')
  }
  // The CommonJS entry (what require.resolve finds) has its names on the default export only.
  return { defineConfig: module.defineConfig ?? module.default.defineConfig, devices: module.devices ?? module.default.devices }
}

const { defineConfig, devices } = await playwright()

export default defineConfig({
  testDir: 'test',
  globalSetup: fileURLToPath(new URL('./global-setup.mjs', import.meta.url)),
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: { headless: true },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
})
