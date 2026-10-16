// The disable-comment check (tools/disable-comments.mjs): the comment scanner on sources, the
// problems it reports, and the CLI on a fixture repo with oxlint's own file list.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, comments, parseDirective, problems } from './disable-comments.mjs'

const CLI = fileURLToPath(new URL('./disable-comments.mjs', import.meta.url))
const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** The lines of `source` with a problem, and the kinds of problem ('rule', 'reason'). */
const found = source => problems(source).map(p => [p.line, /names no rule/.test(p.message) ? 'rule' : 'reason'])

describe('comments', () => {
  test('line and block comments with the line each starts on', () => {
    const source = 'a() // one\n/* two\n three */ b()\n// four'
    assert.deepEqual(comments(source), [
      { text: ' one', line: 1 },
      { text: ' two\n three ', line: 2 },
      { text: ' four', line: 4 },
    ])
  })

  test('not inside strings, templates or regex literals', () => {
    const source = [
      `const a = '// x', b = "/* y */"`,
      'const c = `// z ${a}`',
      'const d = /\\/\\/ w/g.test(a) // real',
      "const e = s.split('/') // also real",
      'return /[/]/.test(a) /* last */',
    ].join('\n')
    assert.deepEqual(
      comments(source).map(c => [c.line, c.text]),
      [
        [3, ' real'],
        [4, ' also real'],
        [5, ' last '],
      ],
    )
  })

  test('a division is not a regex', () => {
    assert.deepEqual(comments('const half = total / 2 // a\nconst q = (a) / (b) / 3 // b'), [
      { text: ' a', line: 1 },
      { text: ' b', line: 2 },
    ])
  })
})

describe('directives', () => {
  test('every disable form, oxlint and eslint spellings; the rules and the reason', () => {
    for (const kind of ['oxlint-disable', 'oxlint-disable-line', 'oxlint-disable-next-line', 'eslint-disable']) {
      assert.deepEqual(parseDirective(` ${kind} no-console, max-lines -- the CLI prints `), {
        kind,
        rules: 'no-console, max-lines',
        reason: 'the CLI prints',
      })
    }
    assert.equal(parseDirective(' oxlint-enable no-console'), null)
    assert.equal(parseDirective(' see oxlint-disable-next-line in the docs'), null)
    assert.equal(parseDirective(' oxlint-disabled'), null)
  })

  test('a disable without a reason, or without a rule, is a problem; a described one is not', () => {
    const source = [
      '// oxlint-disable-next-line no-console -- the CLI prints',
      '// oxlint-disable-next-line no-console',
      'x() // eslint-disable-line complexity --',
      '/* oxlint-disable max-lines */',
      '/* eslint-disable -- everything */',
      '// oxlint-disable-next-line no-console--why',
      '// oxlint-enable no-console',
    ].join('\n')
    assert.deepEqual(found(source), [
      [2, 'reason'],
      [3, 'reason'],
      [4, 'reason'],
      [5, 'rule'],
      [6, 'reason'],
    ])
    assert.match(problems('// oxlint-disable-line no-console')[0].message, /"oxlint-disable-line <rule> -- <why>"/)
  })

  test('a directive spelled in a string is not one', () => {
    assert.deepEqual(problems("const hint = '// oxlint-disable-next-line no-console'\n"), [])
  })

  test('check: file:line for each problem', () => {
    const files = { 'a.ts': 'ok()\n// oxlint-disable-next-line no-console\n', 'b.mjs': 'ok()\n' }
    assert.deepEqual(check(Object.keys(files), { read: file => files[file] }), [
      'a.ts:2: oxlint-disable-next-line without a reason: write it as "oxlint-disable-next-line <rule> -- <why>"',
    ])
  })
})

describe('the CLI', () => {
  const run = (root, paths = []) => spawnSync(process.execPath, [CLI, ...paths], { cwd: root, encoding: 'utf8' })

  test('the files oxlint lints: its ignorePatterns hold here too; with paths, only those', () => {
    const root = mkdtempSync(join(tmpdir(), 'tilr-disable-'))
    dirs.push(root)
    for (const dir of ['src', 'gen']) mkdirSync(join(root, dir))
    const bare = '// oxlint-disable-next-line no-console\nconsole.log(1)\n'
    writeFileSync(join(root, '.oxlintrc.json'), JSON.stringify({ ignorePatterns: ['gen/'] }))
    writeFileSync(join(root, 'src/a.ts'), bare)
    writeFileSync(join(root, 'src/b.ts'), '// oxlint-disable-next-line no-console -- a reason\nconsole.log(1)\n')
    writeFileSync(join(root, 'gen/c.ts'), bare)
    writeFileSync(join(root, 'README.md'), bare)
    const all = run(root)
    assert.equal(all.status, 1)
    assert.match(all.stderr, /^src\/a\.ts:1: oxlint-disable-next-line without a reason/m)
    assert.doesNotMatch(all.stderr, /gen\/c\.ts|README/)
    assert.equal(run(root, ['src/b.ts', 'gen/c.ts', 'README.md']).status, 0)
    assert.equal(run(root, ['src/a.ts']).status, 1)
  })
})
