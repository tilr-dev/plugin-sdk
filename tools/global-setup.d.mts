// The types of tools/global-setup.mjs (`@tilr-dev/plugin/test/global-setup`).
import type { FullConfig } from '@playwright/test'

/** Builds the plugin whose Playwright config is running (`tilr-plugin build` in its folder). */
export default function build(config?: FullConfig): void
