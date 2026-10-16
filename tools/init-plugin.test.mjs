// `tilr-plugin init` (tools/init-plugin.mjs) on copies of the template's files in temp folders,
// each a git repo with or without an origin.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentsSection, githubUrls, initPlugin, replaceName } from './init-plugin.mjs'

const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** The template's package.json, as far as init cares. */
const TEMPLATE_PKG = {
  name: 'tilr-plugin-hello',
  version: '0.3.0',
  private: true,
  type: 'module',
  description: 'The Tilr plugin template',
  license: 'MIT OR Apache-2.0',
  homepage: 'https://github.com/tilr-dev/plugin-template#readme',
  repository: { type: 'git', url: 'git+https://github.com/tilr-dev/plugin-template.git' },
  bugs: { url: 'https://github.com/tilr-dev/plugin-template/issues' },
  engines: { node: '>=22.18' },
  tilr: { name: 'hello' },
  scripts: { build: 'tilr-plugin build' },
}

const AGENTS = `# Working in this Tilr plugin repo

## Commits

- Conventional Commits.

---

## This repo

The template, and the \`hello\` example plugin.
`

const INDEX = `import { definePlugin } from 'tilr'

/** The plugin's name. */
const NAME = 'hello'

export default definePlugin({ name: NAME, apply() {} })
`

/** Git without the GIT_* variables a hook sets (GIT_DIR would point every call at this repo). */
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
const git = (root, args) => spawnSync('git', args, { cwd: root, env: ENV })

/** A template copy in a temp folder (a git repo; `origin` added when given). */
function repo({ origin = null, pkg = TEMPLATE_PKG, index = INDEX } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tilr-init-'))
  dirs.push(root)
  const files = {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify({ name: pkg.name, version: pkg.version, packages: { '': { name: pkg.name, version: pkg.version } } }, null, 2)}\n`,
    'src/index.ts': index,
    'README.md': '# Tilr plugin template\n',
    'AGENTS.md': AGENTS,
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git(root, ['init', '-q'])
  if (origin) git(root, ['remote', 'add', 'origin', origin])
  return root
}

const read = (root, path) => readFileSync(join(root, path), 'utf8')
const readPkg = root => JSON.parse(read(root, 'package.json'))
/** initPlugin with its log collected. */
async function init(root, argv) {
  const lines = []
  const changed = await initPlugin({ root, argv, log: line => lines.push(line) })
  return { changed, log: lines.join('\n') }
}

describe('githubUrls', () => {
  const want = {
    repository: { type: 'git', url: 'git+https://github.com/o/r.git' },
    homepage: 'https://github.com/o/r#readme',
    bugs: { url: 'https://github.com/o/r/issues' },
  }
  for (const remote of [
    'git@github.com:o/r.git',
    'git@github.com:o/r',
    'ssh://git@github.com/o/r.git',
    'https://github.com/o/r.git',
    'https://github.com/o/r',
    'https://token@github.com/o/r.git',
    'git+https://github.com/o/r.git',
  ])
    test(remote, () => assert.deepEqual(githubUrls(remote), want))
  test('not GitHub', () => assert.equal(githubUrls('git@gitlab.com:o/r.git'), null))
})

test('replaceName sets the one NAME line, and throws without one', () => {
  assert.match(replaceName(INDEX, 'clock'), /^const NAME = 'clock'$/m)
  assert.doesNotMatch(replaceName(INDEX, 'clock'), /hello/)
  assert.throws(() => replaceName("export const name = 'hello'\n", 'clock'), /no `const NAME = '…'` line/)
})

test('agentsSection replaces "## This repo" only, and leaves a file without one alone', () => {
  const out = agentsSection(AGENTS, 'clock')
  assert.match(out, /## Commits\n\n- Conventional Commits\./)
  assert.match(out, /## This repo\n\nThe `clock` Tilr plugin\./)
  assert.doesNotMatch(out, /hello/)
  assert.equal(agentsSection('# Rules\n', 'clock'), '# Rules\n')
})

describe('initPlugin', () => {
  test('ssh origin: package.json filled in, key order kept, the files changed', async () => {
    const root = repo({ origin: 'git@github.com:someone/my-plugin.git' })
    const { changed, log } = await init(root, ['my-plugin'])
    assert.deepEqual(changed, ['package.json', 'package-lock.json', 'src/index.ts', 'README.md', 'AGENTS.md'])
    const pkg = readPkg(root)
    assert.deepEqual(Object.keys(pkg), Object.keys(TEMPLATE_PKG))
    assert.equal(pkg.name, 'tilr-plugin-my-plugin')
    assert.equal(pkg.version, '0.1.0')
    assert.equal(pkg.description, '')
    assert.deepEqual(pkg.tilr, { name: 'my-plugin' })
    assert.equal(pkg.repository.url, 'git+https://github.com/someone/my-plugin.git')
    assert.equal(pkg.homepage, 'https://github.com/someone/my-plugin#readme')
    assert.equal(pkg.bugs.url, 'https://github.com/someone/my-plugin/issues')
    assert.ok(read(root, 'package.json').endsWith('}\n'))
    const lock = JSON.parse(read(root, 'package-lock.json'))
    assert.equal(lock.name, 'tilr-plugin-my-plugin')
    assert.equal(lock.packages[''].version, '0.1.0')
    assert.match(read(root, 'src/index.ts'), /^const NAME = 'my-plugin'$/m)
    assert.match(read(root, 'README.md'), /^# my-plugin\n\nA Tilr plugin\.\n/)
    assert.match(read(root, 'AGENTS.md'), /The `my-plugin` Tilr plugin/)
    assert.match(log, /next: npm install && npm run verify/)
  })

  test('https origin', async () => {
    const root = repo({ origin: 'https://github.com/o/r.git' })
    await init(root, ['clock'])
    assert.equal(readPkg(root).homepage, 'https://github.com/o/r#readme')
  })

  test('no origin: the URL keys are removed, with a hint', async () => {
    const root = repo()
    const { log } = await init(root, ['clock'])
    const pkg = readPkg(root)
    for (const key of ['repository', 'homepage', 'bugs']) assert.equal(key in pkg, false, key)
    assert.match(log, /no git remote origin/)
  })

  test('refuses a repo that is not the template; --force inits it anyway', async () => {
    const root = repo({ pkg: { ...TEMPLATE_PKG, tilr: { name: 'clock' } } })
    await assert.rejects(init(root, ['timer']), /tilr\.name is 'clock', not the template's 'hello'.*--force/)
    assert.equal(readPkg(root).tilr.name, 'clock')
    await init(root, ['timer', '--force'])
    assert.equal(readPkg(root).tilr.name, 'timer')
    assert.match(read(root, 'src/index.ts'), /^const NAME = 'timer'$/m)
  })

  test('a bad name, a missing name and an unknown option are refused, nothing written', async () => {
    const root = repo()
    await assert.rejects(init(root, ['../evil']), /bad plugin name '\.\.\/evil'/)
    await assert.rejects(init(root, []), /usage: tilr-plugin init <name>/)
    await assert.rejects(init(root, ['clock', '--bogus']), /unknown option --bogus/)
    assert.equal(readPkg(root).tilr.name, 'hello')
  })

  test('no NAME line in src/index.ts: a clear error, nothing written', async () => {
    const root = repo({ index: "export default { name: 'hello' }\n" })
    await assert.rejects(init(root, ['clock']), /src\/index\.ts: no `const NAME = '…'` line/)
    assert.equal(readPkg(root).tilr.name, 'hello')
    assert.equal(read(root, 'README.md'), '# Tilr plugin template\n')
  })
})
