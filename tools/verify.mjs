// `tilr-plugin verify [--full] [--no-runtime] [--skip a,b] [--only a,b]` and `tilr-plugin hook <name> …`: the
// repo standard's checks (doc: repo-standard.md, §2 and §4), the same in the SDK and in every
// plugin repo. One command for the human, the git hooks and CI: green here, green there.
//
//   format   biome format (format only; Biome's linter is off)
//   lint     eslint . (the repo's eslint.config.js: `@tilr-dev/plugin/eslint`)
//   types    tsc --noEmit, and -p tsconfig.test.json when there is one
//   api      npm run api:check, when package.json has that script
//   unit     npm run test:unit, when package.json has that script
//   dupes    jscpd
//   unused   knip
//   secrets  gitleaks (a Go binary, not on npm: on PATH or $GITLEAKS)
//   deps     npm audit --audit-level=high
//   --full adds:
//   e2e      npm run test:e2e, when package.json has that script
//   pack     npm pack --dry-run, unless the package is private
//
// --no-runtime (or $TILR_NO_RUNTIME=1) skips the steps that need the core page (site/) or a web
// checkout: api, e2e, pack (RUNTIME_STEPS). Unit tests that need site/ skip themselves when it is
// missing. (The SDK's own CI has site/ committed and runs `--full --skip api`.)
//
// The first failing step stops the run (exit 1). A step whose script the repo does not have is
// skipped. Configs: the repo's own (.jscpd.json, knip.json, commitlint.config.js), else this
// package's presets/; biome.json the repo must have (it extends `@tilr-dev/plugin/biome`). Biome, jscpd, knip and commitlint are this package's
// dependencies; eslint and typescript are the repo's (peers). A tool that npm cannot install
// (gitleaks) fails the step on CI ($CI set) and is a warning elsewhere.
//
// Hooks (lefthook.yml, presets/lefthook.yml):
//   hook pre-commit <files…>  biome format and eslint on the staged files, gitleaks on the staged diff
//   hook commit-msg <file>    commitlint (Conventional Commits, no AI attribution)
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const KIT = fileURLToPath(new URL('..', import.meta.url))
export const PRESETS = join(KIT, 'presets')

/** The steps of `verify`, in order; `verify --full` runs FULL_STEPS. */
export const STEPS = ['format', 'lint', 'types', 'api', 'unit', 'dupes', 'unused', 'secrets', 'deps']
export const FULL_STEPS = [...STEPS, 'e2e', 'pack']
/** The steps --no-runtime skips: they need the core page (site/) or the core repo (web). */
export const RUNTIME_STEPS = ['api', 'e2e', 'pack']
const NO_RUNTIME = 'needs core page (web), --no-runtime'

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc']
const JSCPD_CONFIGS = ['.jscpd.json']
const KNIP_CONFIGS = [
  'knip.json',
  'knip.jsonc',
  '.knip.json',
  '.knip.jsonc',
  'knip.config.js',
  'knip.config.mjs',
  'knip.config.ts',
]
const COMMITLINT_CONFIGS = [
  'commitlint.config.js',
  'commitlint.config.mjs',
  'commitlint.config.cjs',
  'commitlint.config.ts',
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yml',
]
/** What eslint lints of the staged files. */
const LINTED = /\.(c|m)?[jt]sx?$/
const SECONDS = 1000
/** The width of a step's name in the summary. */
const NAME_WIDTH = 8

/** Whether `value` (an env var) is set to something other than '', 'false' or '0'. */
const truthy = value => !!value && value !== 'false' && value !== '0'

/** Whether `env` is a CI run (GitHub Actions and most others set CI=true). */
export const isCI = (env = process.env) => truthy(env.CI)

/** The repo's package.json ({} without one). */
export function readPackage(root) {
  const file = join(root, 'package.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

/** The first of `names` that exists in `root`, as a path; null for none. */
const firstFile = (root, names) => names.map(name => join(root, name)).find(path => existsSync(path)) ?? null

/** The JS file of `pkg`'s bin `name`, looked up from each of `roots` upwards (node_modules/<pkg>),
 *  the repo's copy before this package's; null when neither has it. */
export function packageBin(pkg, name, roots = [process.cwd(), KIT]) {
  for (const root of roots) {
    for (let dir = resolve(root); ; dir = dirname(dir)) {
      const manifest = join(dir, 'node_modules', pkg, 'package.json')
      if (existsSync(manifest)) {
        const { bin } = JSON.parse(readFileSync(manifest, 'utf8'))
        const file = typeof bin === 'string' ? bin : bin?.[name]
        if (file) return join(dirname(manifest), file)
      }
      if (dirname(dir) === dir) break
    }
  }
  return null
}

/** An executable `name` on $PATH, or $<NAME> (e.g. $GITLEAKS) when set; null when there is none. */
export function onPath(name, env = process.env) {
  const own = env[name.toUpperCase()]
  if (own) return own
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK)
      return join(dir, name)
    } catch {}
  }
  return null
}

/** A command that runs a package's bin with this Node: [file, args]. */
function node(pkg, bin, args, root) {
  const file = packageBin(pkg, bin, [root, KIT])
  if (!file) return { missing: `${pkg} is not installed (npm install in ${root})` }
  return { cmds: [[process.execPath, [file, ...args]]] }
}

/** The npm script `name` as a command, or a skip when package.json has no such script. */
function script(pkg, name) {
  return pkg.scripts?.[name] ? { cmds: [['npm', ['run', '--silent', name]]] } : { skip: `no "${name}" script` }
}

/** gitleaks with `args`, or what to do without it: fail on CI, a warning elsewhere. */
function gitleaks(args, env) {
  const bin = onPath('gitleaks', env)
  if (bin) return { cmds: [[bin, [...args, '--redact', '--no-banner']]] }
  const how =
    'install it (brew install gitleaks, or a release binary from github.com/gitleaks/gitleaks) or set $GITLEAKS'
  return isCI(env)
    ? { missing: `gitleaks is not on PATH: ${how}` }
    : { warn: `gitleaks is not on PATH, secrets not scanned: ${how}` }
}

/** biome format with `args`: the repo's biome.json (Biome takes a root config only from the repo). */
function biome(args, root) {
  if (!firstFile(root, BIOME_CONFIGS)) {
    return { missing: 'no biome.json: add one with { "root": true, "extends": ["@tilr-dev/plugin/biome"] }' }
  }
  return node('@biomejs/biome', 'biome', ['format', ...args], root)
}

/** typescript's tsc on tsconfig.json and, when there is one, tsconfig.test.json. */
function types(root) {
  const tsc = packageBin('typescript', 'tsc', [root, KIT])
  if (!tsc) return { missing: `typescript is not installed (npm install in ${root})` }
  const projects = ['tsconfig.json', 'tsconfig.test.json'].filter(name => existsSync(join(root, name)))
  if (!projects.length) return { skip: 'no tsconfig.json' }
  return { cmds: projects.map(project => [process.execPath, [tsc, '--noEmit', '-p', project]]) }
}

/** What each step runs, from the repo's folder, its env and its package.json. */
const PLANS = {
  format: ({ root }) => biome(['.'], root),
  lint: ({ root }) => node('eslint', 'eslint', ['.'], root),
  types: ({ root }) => types(root),
  api: ({ pkg }) => script(pkg, 'api:check'),
  unit: ({ pkg }) => script(pkg, 'test:unit'),
  dupes: ({ root }) =>
    node('jscpd', 'jscpd', ['-c', firstFile(root, JSCPD_CONFIGS) ?? join(PRESETS, 'jscpd.json'), '.'], root),
  unused: ({ root, pkg }) => {
    const own = firstFile(root, KNIP_CONFIGS) || pkg.knip
    return node('knip', 'knip', ['--no-progress', ...(own ? [] : ['--config', join(PRESETS, 'knip.json')])], root)
  },
  secrets: ({ root, env }) => gitleaks(existsSync(join(root, '.git')) ? ['git', '.'] : ['dir', '.'], env),
  deps: () => ({ cmds: [['npm', ['audit', '--audit-level=high']]] }),
  e2e: ({ pkg }) => script(pkg, 'test:e2e'),
  pack: ({ pkg }) => (pkg.private ? { skip: 'private package' } : { cmds: [['npm', ['pack', '--dry-run']]] }),
}

/** One step of verify as what to run: `{ cmds }`, or `{ skip }`, `{ warn }`, `{ missing }`.
 *  With `noRuntime` (default: $TILR_NO_RUNTIME), RUNTIME_STEPS are skipped. */
export function step(
  name,
  { root, env = process.env, pkg = readPackage(root), noRuntime = truthy(env.TILR_NO_RUNTIME) },
) {
  if (!Object.hasOwn(PLANS, name)) throw new Error(`unknown step ${name}; the steps are ${FULL_STEPS.join(', ')}`)
  if (noRuntime && RUNTIME_STEPS.includes(name)) return { skip: NO_RUNTIME }
  return PLANS[name]({ root, env, pkg })
}

/** The steps a run takes: STEPS or FULL_STEPS, less --skip, or only --only (comma lists). */
export function selectSteps({ full = false, skip = [], only = [] } = {}) {
  for (const name of [...skip, ...only]) if (!FULL_STEPS.includes(name)) throw new Error(`unknown step ${name}`)
  const all = full ? FULL_STEPS : STEPS
  return (only.length ? FULL_STEPS.filter(name => only.includes(name)) : all).filter(name => !skip.includes(name))
}

/** Runs a command in `root`, its output on this terminal; resolves to its exit status. */
export function exec([file, args], root) {
  const child = spawnSync(file, args, { cwd: root, stdio: 'inherit' })
  if (child.error) {
    console.error(`[verify] ${file}: ${child.error.message}`)
    return 1
  }
  return child.status ?? 1
}

/** A planned step that runs nothing: its key, how it is logged, its status. */
const NOT_RUN = [
  ['skip', 'skipped', 'skip'],
  ['warn', 'warning', 'warn'],
  ['missing', 'error', 'fail'],
]

/** Runs one planned step: 'ok', 'skip', 'warn' or 'fail'. */
function runStep(planned, { root, run, log }) {
  for (const [key, label, status] of NOT_RUN) {
    if (planned[key]) {
      log(`${label}: ${planned[key]}`)
      return status
    }
  }
  for (const cmd of planned.cmds) if (run(cmd, root) !== 0) return 'fail'
  return 'ok'
}

/** Runs `names` in order until one fails. Resolves to { ok, results: [{ name, status, ms }] }.
 *  `noRuntime` skips RUNTIME_STEPS (default: $TILR_NO_RUNTIME); `run` and `log` are for the
 *  tests (default: exec and console.log). */
export function runSteps(
  names,
  {
    root = process.cwd(),
    env = process.env,
    noRuntime = truthy(env.TILR_NO_RUNTIME),
    run = exec,
    log = console.log,
  } = {},
) {
  const pkg = readPackage(root)
  const results = []
  for (const name of names) {
    log(`\n▸ ${name}`)
    const start = performance.now()
    const status = runStep(step(name, { root, env, pkg, noRuntime }), {
      root,
      run,
      log: text => log(`  ${name}: ${text}`),
    })
    results.push({ name, status, ms: Math.round(performance.now() - start) })
    if (status === 'fail') break
  }
  const ok = results.every(r => r.status !== 'fail')
  log(`\n${summary(results)}\n${ok ? 'verify: ok' : `verify: ${results.at(-1).name} failed`}`)
  return { ok, results }
}

/** The results as one line per step: ✓ / ✗ / – (skipped) / ! (warning), with the seconds. */
export function summary(results) {
  const mark = { ok: '✓', fail: '✗', skip: '–', warn: '!' }
  return results.map(r => `${mark[r.status]} ${r.name.padEnd(NAME_WIDTH)} ${(r.ms / SECONDS).toFixed(1)}s`).join('\n')
}

/** `pre-commit <files…>`: format and lint the staged files, scan the staged diff for secrets. */
function preCommit(files, { root, env }) {
  const planned = []
  if (files.length) {
    planned.push(['format', biome(['--no-errors-on-unmatched', '--files-ignore-unknown=true', ...files], root)])
  }
  const linted = files.filter(file => LINTED.test(file))
  if (linted.length) planned.push(['lint', node('eslint', 'eslint', ['--no-warn-ignored', ...linted], root)])
  planned.push(['secrets', gitleaks(['git', '--pre-commit', '--staged', '.'], env)])
  return planned
}

/** `commit-msg <file>`: commitlint on the message, with the repo's config or the preset. */
function commitMsg([file], { root }) {
  if (!file) throw new Error('usage: tilr-plugin hook commit-msg <message file>')
  const config = firstFile(root, COMMITLINT_CONFIGS) ?? join(PRESETS, 'commitlint.js')
  return [['commitlint', node('@commitlint/cli', 'commitlint', ['--config', config, '--edit', file], root)]]
}

/** Runs the git hook `name` (pre-commit, commit-msg) with lefthook's arguments; true when it passed. */
export function runHook(name, args, { root = process.cwd(), env = process.env, run = exec, log = console.error } = {}) {
  const hooks = { 'pre-commit': preCommit, 'commit-msg': commitMsg }
  if (!hooks[name]) throw new Error(`unknown hook ${name}; the hooks are ${Object.keys(hooks).join(', ')}`)
  for (const [label, planned] of hooks[name](args, { root, env })) {
    if (runStep(planned, { root, run, log: text => log(`[${name}] ${label}: ${text}`) }) === 'fail') return false
  }
  return true
}

/** `tilr-plugin verify` argv → selectSteps() options, and `noRuntime` (true with --no-runtime,
 *  else undefined: $TILR_NO_RUNTIME decides). */
export function parseVerifyArgs(argv) {
  const list = flag => {
    const i = argv.indexOf(flag)
    return i === -1 ? [] : (argv[i + 1] ?? '').split(',').filter(Boolean)
  }
  const noRuntime = argv.includes('--no-runtime') || undefined
  return { full: argv.includes('--full'), skip: list('--skip'), only: list('--only'), noRuntime }
}
