// A shell window may serve a managed project's site/ or a standalone site (the Mac default).
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { installSite, pluginName } from './install-site.js'
import { corePlugins, expandHome } from './paths.js'

export function pluginTarget(row) {
  const site = realpathSync(row.site)
  const dir = dirname(site)
  const manifest = join(dir, 'tilr.json')
  // A manifest beside an unrelated site must not redirect installation to dir/site.
  if (existsSync(manifest) && existsSync(join(dir, 'site')) && realpathSync(join(dir, 'site')) === site) {
    return { site, dir }
  }
  return { site, dir: null }
}

/** Install core plugins or local plugin builds without changing the site's core or layout.
 * Git sources and refs need a managed project's clone lifecycle; never ignore a ref here. */
export async function addSitePlugins({ site, sources, ref, kit }) {
  if (!Array.isArray(sources) || !sources.length || sources.some(s => typeof s !== 'string' || !s)) {
    throw new Error('sources must contain at least one plugin name or local path')
  }
  if (ref !== undefined) throw new Error('Git refs require a managed app with tilr.json; for a standalone site pass a local plugin checkout without ref')
  if (!existsSync(join(site, 'index.html'))) throw new Error(`${site}: no Tilr page`)
  const core = corePlugins(kit)
  // Resolve and validate every source before any installation or build.
  const plans = sources.map(source => {
    if (core.includes(source)) return { name: source, dist: join(kit, 'site/plugins', source) }
    const dir = resolve(expandHome(source))
    if (!existsSync(join(dir, 'package.json'))) {
      throw new Error(`${source}: standalone sites accept core plugin names or local plugin directories; Git URLs require a managed app with tilr.json`)
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return { name: pluginName(pkg), dir, build: !!pkg.scripts?.build, dist: resolve(dir, pkg.tilr?.dist ?? 'dist') }
  })
  const plugins = {}
  for (const plan of plans) {
    if (Object.hasOwn(plugins, plan.name)) throw new Error(`duplicate plugin ${plan.name}`)
    plugins[plan.name] = plan.dist
  }
  for (const plan of plans) {
    if (plan.build) {
      const result = spawnSync('npm', ['run', 'build'], { cwd: plan.dir, encoding: 'utf8' })
      if (result.error || result.status !== 0) throw new Error(`${plan.name}: build failed: ${result.error?.message ?? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`)
    }
    if (!existsSync(join(plan.dist, 'index.js'))) throw new Error(`${plan.dist}: no index.js; build the plugin first`)
  }
  const changed = await installSite({ site, plugins })
  return { site, plugins: plans.map(p => p.name), changed }
}
