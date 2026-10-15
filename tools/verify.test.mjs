// `tilr-plugin verify` and `tilr-plugin hook` (tools/verify.mjs): the plan for fixture repos in
// temp folders, run with a recording runner; plus the CLI itself on a tiny repo (format only).
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FULL_STEPS,
  PRESETS,
  RUNTIME_STEPS,
  STEPS,
  isCI,
  onPath,
  packageBin,
  parseVerifyArgs,
  runHook,
  runSteps,
  selectSteps,
  step,
  summary,
} from './verify.mjs'

const CLI = fileURLToPath(new URL('./tilr-plugin.mjs', import.meta.url))
const KIT = fileURLToPath(new URL('..', import.meta.url))
const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A repo in a temp folder: package.json (`pkg`) + `files` (path → text). */
function fixture(pkg = {}, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tilr-verify-'))
  dirs.push(root)
  for (const [path, text] of Object.entries({ 'package.json': JSON.stringify(pkg), ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

/** A fake executable `name` in a temp folder: an env whose PATH has it (and nothing else). */
function fakeBin(name) {
  const dir = fixture()
  writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, name), 0o755)
  return { PATH: dir }
}

/** runSteps / runHook with a runner that records the commands and fails those `fail` matches. */
function recorder(fail = () => false) {
  const ran = []
  const lines = []
  return {
    ran,
    lines,
    run: cmd => {
      ran.push(cmd)
      return fail(cmd) ? 1 : 0
    },
    log: line => lines.push(line),
  }
}

/** The arguments of a recorded command, after the bin's file (node <file> args…). */
const args = cmd => (cmd[0] === process.execPath ? cmd[1].slice(1) : cmd[1])

describe('the plan', () => {
  test('verify runs the standard steps in order; --full adds e2e and pack', () => {
    assert.deepEqual(STEPS, ['format', 'lint', 'types', 'api', 'unit', 'dupes', 'unused', 'secrets', 'deps'])
    assert.deepEqual(selectSteps(), STEPS)
    assert.deepEqual(selectSteps({ full: true }), FULL_STEPS)
    assert.deepEqual(selectSteps({ full: true, skip: ['deps', 'e2e'] }), [...STEPS.slice(0, -1), 'pack'])
    assert.deepEqual(selectSteps({ only: ['unit', 'format'] }), ['format', 'unit'])
    assert.throws(() => selectSteps({ skip: ['nope'] }), /unknown step nope/)
    assert.deepEqual(parseVerifyArgs(['--full', '--skip', 'deps,secrets']), {
      full: true,
      skip: ['deps', 'secrets'],
      only: [],
      noRuntime: undefined,
    })
    assert.equal(parseVerifyArgs(['--no-runtime']).noRuntime, true)
  })

  test('scripts the repo does not have are skipped; a private package is not packed', () => {
    const root = fixture({ name: 'p', private: true, scripts: {} })
    for (const name of ['api', 'unit', 'e2e', 'pack']) assert.ok(step(name, { root }).skip, name)
    const sdk = fixture({ name: '@x/sdk', scripts: { 'api:check': 'x', 'test:unit': 'x', 'test:e2e': 'x' } })
    const env = {}
    assert.deepEqual(step('api', { root: sdk, env }).cmds, [['npm', ['run', '--silent', 'api:check']]])
    assert.deepEqual(step('unit', { root: sdk, env }).cmds, [['npm', ['run', '--silent', 'test:unit']]])
    assert.deepEqual(step('e2e', { root: sdk, env }).cmds, [['npm', ['run', '--silent', 'test:e2e']]])
    assert.deepEqual(step('pack', { root: sdk, env }).cmds, [['npm', ['pack', '--dry-run']]])
    assert.deepEqual(step('deps', { root: sdk, env }).cmds, [['npm', ['audit', '--audit-level=high']]])
  })

  test('--no-runtime / $TILR_NO_RUNTIME skip the steps that need the core page (web)', () => {
    const sdk = fixture({ name: '@x/sdk', scripts: { 'api:check': 'x', 'test:unit': 'x', 'test:e2e': 'x' } })
    assert.deepEqual(RUNTIME_STEPS, ['api', 'e2e', 'pack'])
    for (const name of RUNTIME_STEPS) {
      assert.match(step(name, { root: sdk, env: {}, noRuntime: true }).skip, /needs core page \(web\)/, name)
      assert.match(step(name, { root: sdk, env: { TILR_NO_RUNTIME: '1' } }).skip, /needs core page/, name)
      assert.ok(step(name, { root: sdk, env: { TILR_NO_RUNTIME: '0' } }).cmds, name)
      assert.ok(step(name, { root: sdk, env: { TILR_NO_RUNTIME: '1' }, noRuntime: false }).cmds, name)
    }
    assert.ok(step('unit', { root: sdk, env: {}, noRuntime: true }).cmds)
    const ran = []
    const lines = []
    const { ok, results } = runSteps(['unit', 'api', 'pack'], {
      root: sdk,
      env: {},
      noRuntime: true,
      run: cmd => ran.push(cmd) && 0,
      log: line => lines.push(line),
    })
    assert.ok(ok)
    assert.deepEqual(
      results.map(r => r.status),
      ['ok', 'skip', 'skip'],
    )
    assert.equal(ran.length, 1)
    assert.ok(
      lines.some(line => line.includes('api: skipped: needs core page (web)')),
      lines.join('\n'),
    )
  })

  test('without configs of its own a repo gets the presets (but biome.json); with them, its own', () => {
    const bare = fixture({ name: 'p' })
    // Biome takes its root config only from the repo: a biome.json that extends the preset.
    assert.match(step('format', { root: bare }).missing, /no biome\.json/)
    assert.deepEqual(args(step('dupes', { root: bare }).cmds[0]), ['-c', join(PRESETS, 'jscpd.json'), '.'])
    assert.deepEqual(args(step('unused', { root: bare }).cmds[0]), [
      '--no-progress',
      '--config',
      join(PRESETS, 'knip.json'),
    ])
    const own = fixture({ name: 'p' }, { 'biome.json': '{}', '.jscpd.json': '{}', 'knip.json': '{}' })
    assert.deepEqual(args(step('format', { root: own }).cmds[0]), ['format', '.'])
    assert.deepEqual(args(step('dupes', { root: own }).cmds[0]), ['-c', join(own, '.jscpd.json'), '.'])
    assert.deepEqual(args(step('unused', { root: own }).cmds[0]), ['--no-progress'])
    assert.deepEqual(args(step('unused', { root: fixture({ knip: {} }) }).cmds[0]), ['--no-progress'])
  })

  test('types: tsc on tsconfig.json and tsconfig.test.json when they exist', () => {
    assert.ok(step('types', { root: fixture() }).skip)
    const root = fixture({}, { 'tsconfig.json': '{}', 'tsconfig.test.json': '{}' })
    assert.deepEqual(step('types', { root }).cmds.map(args), [
      ['--noEmit', '-p', 'tsconfig.json'],
      ['--noEmit', '-p', 'tsconfig.test.json'],
    ])
  })

  test('the tools resolve from the repo first, then from this package', () => {
    const root = fixture({}, { 'node_modules/jscpd/package.json': JSON.stringify({ bin: { jscpd: './own.js' } }) })
    assert.equal(packageBin('jscpd', 'jscpd', [join(root, 'deep/er'), root]), join(root, 'node_modules/jscpd/own.js'))
    assert.match(packageBin('knip', 'knip'), /node_modules\/knip\/bin\/knip\.js$/)
    assert.equal(packageBin('no-such-package-here', 'x', [fixture()]), null)
  })

  test('gitleaks: on PATH or $GITLEAKS; missing, it fails on CI and warns elsewhere', () => {
    const git = fixture({}, { '.git/HEAD': 'ref: refs/heads/master\n' })
    const found = step('secrets', { root: git, env: fakeBin('gitleaks') }).cmds[0]
    assert.match(found[0], /gitleaks$/)
    assert.deepEqual(found[1], ['git', '.', '--redact', '--no-banner'])
    assert.deepEqual(step('secrets', { root: fixture(), env: { GITLEAKS: '/opt/gl' } }).cmds[0], [
      '/opt/gl',
      ['dir', '.', '--redact', '--no-banner'],
    ])
    assert.match(step('secrets', { root: git, env: { PATH: '' } }).warn, /gitleaks is not on PATH/)
    assert.match(step('secrets', { root: git, env: { PATH: '', CI: 'true' } }).missing, /gitleaks is not on PATH/)
    assert.equal(onPath('gitleaks', { PATH: '' }), null)
    assert.deepEqual(
      [isCI({ CI: 'true' }), isCI({ CI: '1' }), isCI({ CI: 'false' }), isCI({})],
      [true, true, false, false],
    )
  })
})

describe('running', () => {
  test('the first failing step stops the run', () => {
    const root = fixture({ name: 'p', scripts: { 'test:unit': 'x', 'api:check': 'x' } })
    const r = recorder(cmd => cmd[1].includes('api:check'))
    const { ok, results } = runSteps(['api', 'unit', 'deps'], { root, env: {}, ...r })
    assert.equal(ok, false)
    assert.deepEqual(
      results.map(x => [x.name, x.status]),
      [['api', 'fail']],
    )
    assert.equal(r.ran.length, 1)
    assert.match(r.lines.at(-1), /verify: api failed/)
  })

  test('skips and warnings do not fail the run; the summary lists every step', () => {
    const root = fixture({ name: 'p', private: true })
    const r = recorder()
    const { ok, results } = runSteps(['unit', 'secrets', 'deps', 'pack'], { root, env: { PATH: '' }, ...r })
    assert.equal(ok, true)
    assert.deepEqual(
      results.map(x => x.status),
      ['skip', 'warn', 'ok', 'skip'],
    )
    assert.deepEqual(r.ran, [['npm', ['audit', '--audit-level=high']]])
    assert.match(summary(results), /^– unit +\d+\.\ds\n! secrets/)
    assert.equal(r.lines.at(-1).split('\n').at(-1), 'verify: ok')
  })

  test('a tool that is required but missing fails the step on CI', () => {
    const r = recorder()
    const { ok, results } = runSteps(['secrets', 'deps'], { root: fixture(), env: { PATH: '', CI: 'true' }, ...r })
    assert.equal(ok, false)
    assert.deepEqual(
      results.map(x => x.status),
      ['fail'],
    )
    assert.ok(r.lines.some(line => line.includes('error: gitleaks is not on PATH')))
  })
})

describe('hooks', () => {
  test('pre-commit formats the staged files, lints the scripts among them, scans the staged diff', () => {
    const root = fixture({ name: 'p' }, { 'biome.json': '{}' })
    const r = recorder()
    assert.equal(
      runHook('pre-commit', ['src/a.ts', 'README.md', 'b.mjs'], { root, env: fakeBin('gitleaks'), ...r }),
      true,
    )
    assert.deepEqual(args(r.ran[0]), [
      'format',
      '--no-errors-on-unmatched',
      '--files-ignore-unknown=true',
      'src/a.ts',
      'README.md',
      'b.mjs',
    ])
    assert.deepEqual(args(r.ran[1]), ['--no-warn-ignored', 'src/a.ts', 'b.mjs'])
    assert.deepEqual(r.ran[2][1], ['git', '--pre-commit', '--staged', '.', '--redact', '--no-banner'])
  })

  test('pre-commit stops at the first failure', () => {
    const r = recorder(() => true)
    const root = fixture({}, { 'biome.json': '{}' })
    assert.equal(runHook('pre-commit', ['a.ts'], { root, env: { PATH: '' }, ...r }), false)
    assert.equal(r.ran.length, 1)
  })

  test("commit-msg runs commitlint with the repo's config, else the preset", () => {
    const r = recorder()
    runHook('commit-msg', ['.git/COMMIT_EDITMSG'], { root: fixture(), ...r })
    assert.deepEqual(args(r.ran[0]), ['--config', join(PRESETS, 'commitlint.js'), '--edit', '.git/COMMIT_EDITMSG'])
    const own = fixture({}, { 'commitlint.config.js': 'export default {}' })
    runHook('commit-msg', ['m'], { root: own, ...r })
    assert.deepEqual(args(r.ran[1]), ['--config', join(own, 'commitlint.config.js'), '--edit', 'm'])
    assert.throws(() => runHook('commit-msg', [], { root: own, ...r }), /usage/)
    assert.throws(() => runHook('post-merge', [], { root: own, ...r }), /unknown hook/)
  })

  test('the commitlint preset: Conventional Commits with the standard types, no AI attribution', () => {
    const lint = message =>
      spawnSync(
        process.execPath,
        [packageBin('@commitlint/cli', 'commitlint'), '--config', join(PRESETS, 'commitlint.js')],
        { input: message, encoding: 'utf8', cwd: fixture() },
      ).status
    assert.equal(lint('feat(build): bundle workers'), 0)
    assert.equal(lint('feat(api)!: drop x\n\nBREAKING CHANGE: x is gone'), 0)
    assert.equal(lint('fix: y\n\nRefs: #12'), 0)
    assert.equal(lint('Added stuff'), 1)
    assert.equal(lint('style: format'), 1)
    assert.equal(lint('fix: z\n\nGenerated with [Claude Code](https://claude.ai/code)'), 1)
    assert.equal(lint('docs: z\n\nCo-Authored-By: Claude <noreply@anthropic.com>'), 1)
  })
})

describe('the CLI', () => {
  test('tilr-plugin verify --only format: a formatted repo passes, a misformatted one fails', () => {
    // A plugin repo as the template makes it: biome.json extends the preset from node_modules.
    const repo = source => {
      const root = fixture(
        { name: 'p' },
        {
          'package.json': '{\n  "name": "p"\n}\n',
          '.gitignore': 'node_modules/\n',
          'biome.json': '{ "root": true, "extends": ["@tilr-dev/plugin/biome"] }\n',
          'src/a.ts': source,
        },
      )
      mkdirSync(join(root, 'node_modules/@tilr-dev'), { recursive: true })
      symlinkSync(KIT, join(root, 'node_modules/@tilr-dev/plugin'))
      return root
    }
    const run = root =>
      spawnSync(process.execPath, [CLI, 'verify', '--only', 'format'], { cwd: root, encoding: 'utf8' })
    const ok = run(repo("export const a = 'a'\n"))
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`)
    assert.match(ok.stdout, /✓ format/)
    const bad = repo('export const a = "a";\n')
    const failed = run(bad)
    assert.equal(failed.status, 1, `${failed.stdout}${failed.stderr}`)
    assert.match(failed.stdout, /verify: format failed/)
  })
})
