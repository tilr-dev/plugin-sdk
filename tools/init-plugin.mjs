// `tilr-plugin init <name> [--force]`: makes a fresh copy of the template repo
// (github.com/tilr-dev/plugin-template, "Use this template") into the plugin `<name>`. It fills in
// what the template has, it copies no files:
// - package.json: `name` tilr-plugin-<name>, `tilr.name`, `version` 0.1.0, `description` "",
//   `repository` / `homepage` / `bugs` from `git remote get-url origin` (GitHub, ssh or https),
//   removed without an origin. Key order kept; package-lock.json's name and version follow.
// - src/index.ts (or .tsx): the `const NAME = '…'` line.
// - README.md: a short stub. AGENTS.md: its "## This repo" section (the generic rules stay).
// Refuses a repo that is not the template (`tilr.name` other than `hello`) unless --force.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_NAME } from './install-site.js'

/** The template's plugin name: what `init` expects to replace. */
export const TEMPLATE_NAME = 'hello'

/** The one declaration of the plugin's name in its entry. */
const NAME_LINE = /^const NAME = (['"`])[^'"`\n]*\1/m

/** A GitHub remote (git@github.com:o/r.git, ssh://, https://) → its package.json URLs; null for
 *  anything else. */
export function githubUrls(remote) {
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|(?:git\+)?https:\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    )
  if (!match) return null
  const web = `https://github.com/${match[1]}/${match[2]}`
  return {
    repository: { type: 'git', url: `git+${web}.git` },
    homepage: `${web}#readme`,
    bugs: { url: `${web}/issues` },
  }
}

/** The origin remote's URL of the git repo at `root`; null without git, a repo or an origin.
 *  The GIT_* variables are dropped: under a git hook GIT_DIR would name another repo. */
function originUrl(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const git = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, env, encoding: 'utf8' })
  return git.status === 0 ? git.stdout.trim() : null
}

/** The keys `fillPackage` sets from the remote. */
const URL_KEYS = new Set(['repository', 'homepage', 'bugs'])

/** The other keys `fillPackage` rewrites: old value, name → new value. */
const FILL = {
  name: (_, name) => `tilr-plugin-${name}`,
  version: () => '0.1.0',
  description: () => '',
  tilr: (tilr, name) => ({ ...tilr, name }),
}

/** package.json for the plugin `name`: the same keys in the same order, the URL keys set from
 *  `urls` (appended when the template lacks them) or removed when it is null. */
export function fillPackage(pkg, name, urls) {
  const out = {}
  for (const [key, value] of Object.entries(pkg)) {
    if (URL_KEYS.has(key)) {
      if (urls) out[key] = urls[key]
      continue
    }
    out[key] = Object.hasOwn(FILL, key) ? FILL[key](value, name) : value
  }
  return urls ? { ...out, ...urls } : out
}

/** `source` with its `const NAME = '…'` set to `name`; throws when it has no such line. */
export function replaceName(source, name, file = 'src/index.ts') {
  if (!NAME_LINE.test(source))
    throw new Error(`${file}: no \`const NAME = '…'\` line to set (the template declares the plugin's name there)`)
  return source.replace(NAME_LINE, `const NAME = '${name}'`)
}

/** The README a new plugin starts with. */
export function readmeStub(name) {
  return `# ${name}

A Tilr plugin.

## Develop

\`\`\`sh
npm install
npm run dev:site                                 # a local Tilr page with this plugin, rebuilt on save
npm run verify                                   # the checks (verify:full adds the e2e tests)
npm run install:site -- --site <folder>          # install into a Tilr site
npx tilr-plugin uninstall-site --site <folder>   # remove it again
\`\`\`
`
}

/** AGENTS.md with its "## This repo" section (to the next "## " heading or the end) replaced by a
 *  stub for `name`; unchanged without one. */
export function agentsSection(text, name) {
  const section = /^## This repo\n[\s\S]*?(?=^## |(?![\s\S]))/m
  const stub = `## This repo

The \`${name}\` Tilr plugin. Its name is \`tilr.name\` in package.json and \`NAME\` in
\`src/index.ts\`; the tests read it from package.json.

- \`@tilr-dev/plugin\` comes from npm, never a \`file:\` link.
`
  return text.replace(section, stub)
}

/** `init`'s arguments: the name and --force. */
function parseInitArgs(argv) {
  const names = argv.filter(arg => !arg.startsWith('-'))
  const unknown = argv.filter(arg => arg.startsWith('-') && arg !== '--force')
  if (unknown.length) throw new Error(`init: unknown option ${unknown.join(' ')}`)
  if (names.length !== 1) throw new Error('usage: tilr-plugin init <name> [--force]')
  const [name] = names
  if (!PLUGIN_NAME.test(name))
    throw new Error(`bad plugin name '${name}': letters, digits, '.', '_', '-', starting with a letter or digit`)
  return { name, force: argv.includes('--force') }
}

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)

/** package-lock.json's name and version (top level and the root package) set like package.json's. */
async function fillLock(root, pkg) {
  const path = join(root, 'package-lock.json')
  if (!existsSync(path)) return false
  const lock = await readJson(path)
  for (const entry of [lock, lock.packages?.['']].filter(Boolean)) {
    entry.name = pkg.name
    entry.version = pkg.version
  }
  await writeJson(path, lock)
  return true
}

/** The entry that declares NAME: src/index.ts or src/index.tsx. */
function entryFile(root) {
  const entry = ['src/index.ts', 'src/index.tsx'].find(file => existsSync(join(root, file)))
  if (!entry) throw new Error(`${root}: no src/index.ts or src/index.tsx`)
  return entry
}

/** README.md replaced, AGENTS.md's section replaced when it has one; the files changed. */
async function fillDocs(root, name) {
  const changed = []
  await writeFile(join(root, 'README.md'), readmeStub(name))
  changed.push('README.md')
  const agents = join(root, 'AGENTS.md')
  if (existsSync(agents)) {
    const text = await readFile(agents, 'utf8')
    const next = agentsSection(text, name)
    if (next !== text) {
      await writeFile(agents, next)
      changed.push('AGENTS.md')
    }
  }
  return changed
}

/** Runs `init` in the repo at `root` (see the header). Resolves to the changed files. */
export async function initPlugin({ root = process.cwd(), argv = process.argv.slice(2), log = console.log } = {}) {
  const { name, force } = parseInitArgs(argv)
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) throw new Error(`${root}: no package.json (run init in the root of the plugin repo)`)
  const pkg = await readJson(pkgPath)
  if (pkg.tilr?.name !== TEMPLATE_NAME && !force)
    throw new Error(
      `package.json's tilr.name is '${pkg.tilr?.name}', not the template's '${TEMPLATE_NAME}': this repo looks initialized already (--force to init it anyway)`,
    )
  // Every check before the first write: the entry must have its NAME line.
  const entry = entryFile(root)
  const source = replaceName(await readFile(join(root, entry), 'utf8'), name, entry)

  const remote = originUrl(root)
  const urls = remote ? githubUrls(remote) : null
  const filled = fillPackage(pkg, name, urls)
  await writeJson(pkgPath, filled)
  const changed = ['package.json']
  if (await fillLock(root, filled)) changed.push('package-lock.json')
  await writeFile(join(root, entry), source)
  changed.push(entry, ...(await fillDocs(root, name)))

  log(`[init] ${name}: ${changed.join(' ')}`)
  if (!urls)
    log(
      remote
        ? `[init] origin ${remote} is not on GitHub: set repository, homepage and bugs in package.json yourself`
        : '[init] no git remote origin: repository, homepage and bugs left out of package.json (add the remote and run init --force again, or set them yourself)',
    )
  log('[init] next: npm install && npm run verify')
  return changed
}
