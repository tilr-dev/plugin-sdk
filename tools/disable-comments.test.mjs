// The disable-comment check (tools/disable-comments.mjs): the directive finder on sources, the
// problems it reports, and the CLI on a fixture repo with oxlint's own file list.
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as scan from './disable-comments.mjs'

const CLI = fileURLToPath(new URL('./disable-comments.mjs', import.meta.url))
/** The fixtures spell a comment opener `%%` (`//`) or `%*` (`/*`): written plainly in this file's
 *  strings, they would be directives to the check itself (it does not tell strings from comments). */
const unmask = source => source.replaceAll('%%', '//').replaceAll('%*', '/*')
const directives = source => scan.directives(unmask(source))
const problems = source => scan.problems(unmask(source))
const { parseBody } = scan
const write = (file, source) => writeFileSync(file, unmask(source))
const dirs = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** The kind of a problem's message. */
const KINDS = [
  ['rule', /names no rule/],
  ['reason', /without a reason/],
  ['open', /disable without a matching enable \(whole-file disables are not allowed\)/],
  ['twice', /already disabled at line/],
  ['enable', /without a preceding disable/],
]
/** The lines of `source` with a problem, and the kinds of problem. */
const found = source => problems(source).map(p => [p.line, KINDS.find(([, re]) => re.test(p.message))?.[0]])
/** [line, kind] of each directive of `source`. */
const kinds = source => directives(source).map(d => [d.line, d.kind])

describe('directives', () => {
  test('line and block comments, the line of the directive, its rules and reason', () => {
    const source = [
      'a() %% oxlint-disable-line no-console -- one',
      '%* oxlint-disable max-lines,',
      '   complexity -- two */ b()',
      '/*',
      '  eslint-enable max-lines',
      '*/',
      '%*oxlint-disable-next-line no-console*/',
    ].join('\n')
    assert.deepEqual(directives(source), [
      { kind: 'oxlint-disable-line', rules: 'no-console', reason: 'one', line: 1 },
      { kind: 'oxlint-disable', rules: 'max-lines,\n   complexity', reason: 'two', line: 2 },
      { kind: 'eslint-enable', rules: 'max-lines', reason: '', line: 5 },
      { kind: 'oxlint-disable-next-line', rules: 'no-console', reason: '', line: 7 },
    ])
  })

  test('only right after the comment opener', () => {
    assert.deepEqual(kinds('// see oxlint-disable-next-line in the docs\n%% oxlint-disabled\nx-oxlint-disable'), [])
  })

  test('where a tokenizer guesses wrong: divisions, JSX text, quotes in JSX', () => {
    const cases = [
      'let i = 0\nconst h = i++ / 2 %% oxlint-disable-line no-magic-numbers\n',
      'const a = <p>hi</p> %% oxlint-disable-line no-console\n',
      "const a = <p>Don't</p> %% oxlint-disable-line no-console\n",
      'const a = <code>`</code>\nconst b = 1\n%% oxlint-disable-next-line no-console\nconsole.log(b)\n',
      "if (a) /'/.test(b)\n%% oxlint-disable-next-line no-console\nconsole.log(1)\n",
      'const x = this.w / 2 %% oxlint-disable-line x\n',
    ]
    for (const source of cases) assert.equal(found(source).length, 1, source)
    assert.deepEqual(found(cases[3]), [[3, 'reason']])
  })

  test('the trade-off: a directive spelled in a string counts too (rewrite the string)', () => {
    assert.deepEqual(found("const hint = '%% oxlint-disable-next-line no-console'\n"), [[1, 'reason']])
    assert.deepEqual(found("const hint = '// oxlint' + '-disable-next-line no-console'\n"), [])
  })

  test('parseBody: the rules, then the reason after ` -- `', () => {
    assert.deepEqual(parseBody(' no-console, max-lines -- the CLI prints '), {
      rules: 'no-console, max-lines',
      reason: 'the CLI prints',
    })
    assert.deepEqual(parseBody(' no-console--why'), { rules: 'no-console--why', reason: '' })
    assert.deepEqual(parseBody(''), { rules: '', reason: '' })
  })
})

describe('problems', () => {
  test('every disable form needs its rules and a reason; an enable needs neither', () => {
    for (const kind of ['oxlint-disable-line', 'oxlint-disable-next-line', 'eslint-disable-next-line']) {
      assert.deepEqual(found(`// ${kind} no-console -- why`), [])
      assert.deepEqual(found(`// ${kind} no-console`), [[1, 'reason']])
    }
    const source = [
      '%% oxlint-disable-next-line no-console -- the CLI prints',
      '%% oxlint-disable-next-line no-console',
      'x() %% eslint-disable-line complexity --',
      '%* oxlint-disable max-lines -- a table */',
      '%* oxlint-enable max-lines */',
      '%% eslint-disable-line -- everything',
      '%% oxlint-disable-next-line no-console--why',
    ].join('\n')
    assert.deepEqual(found(source), [
      [2, 'reason'],
      [3, 'reason'],
      [6, 'rule'],
      [7, 'reason'],
    ])
    assert.match(problems('%% oxlint-disable-line no-console')[0].message, /"oxlint-disable-line <rule> -- <why>"/)
  })

  test('a range disable needs a later enable of its rules: no whole-file disables', () => {
    assert.deepEqual(found('%* oxlint-disable max-lines -- a generated table */\nconst t = []\n'), [[1, 'open']])
    assert.deepEqual(found('%% oxlint-disable no-console -- the CLI prints\n'), [[1, 'open']])
    assert.deepEqual(found('%* eslint-disable -- everything */\n'), [
      [1, 'rule'],
      [1, 'open'],
    ])
    assert.match(problems('%* oxlint-disable max-lines -- why */')[0].message, /"\/\* oxlint-enable max-lines \*\/"/)
    // Enabling one of two rules leaves the other open.
    const half = '%* oxlint-disable a, b -- why */\n%* oxlint-enable a */\n'
    assert.deepEqual(found(half), [[1, 'open']])
    assert.match(problems(half)[0].message, /^oxlint-disable b:/)
  })

  test('paired ranges: by rule, by a bare enable, across the oxlint and eslint spellings', () => {
    const paired = [
      '%* oxlint-disable a, b -- why */\n%* oxlint-enable b, a */\n',
      '%* oxlint-disable a -- why */\n%* oxlint-disable b -- why */\n%* oxlint-enable */\n',
      '%* eslint-disable a -- why */\n%* oxlint-enable a */\n',
      '%* oxlint-disable a -- why */\n%* oxlint-enable a */\n%* oxlint-disable a -- again */\n%* oxlint-enable a */\n',
    ]
    for (const source of paired) assert.deepEqual(found(source), [], source)
  })

  test('an enable with nothing to enable, and a rule disabled twice', () => {
    assert.deepEqual(found('%% oxlint-enable no-console'), [[1, 'enable']])
    assert.deepEqual(found('%* oxlint-enable */'), [[1, 'enable']])
    const twice = '%* oxlint-disable a -- why */\n%* oxlint-disable a -- why */\n%* oxlint-enable a */\n'
    assert.deepEqual(found(twice), [[2, 'twice']])
    assert.match(problems(twice)[0].message, /already disabled at line 1/)
  })

  test('check: file:line for each problem', () => {
    const files = { 'a.ts': 'ok()\n%% oxlint-disable-next-line no-console\n', 'b.mjs': 'ok()\n' }
    assert.deepEqual(scan.check(Object.keys(files), { read: file => unmask(files[file]) }), [
      'a.ts:2: oxlint-disable-next-line without a reason: write it as "oxlint-disable-next-line <rule> -- <why>"',
    ])
  })
})

describe('the CLI', () => {
  const run = (root, paths = []) => spawnSync(process.execPath, [CLI, ...paths], { cwd: root, encoding: 'utf8' })
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'tilr-disable-'))
    dirs.push(root)
    return root
  }

  test('the files oxlint lints: its ignorePatterns hold here too; with paths, only those', () => {
    const root = fixture()
    for (const dir of ['src', 'gen']) mkdirSync(join(root, dir))
    const bare = '%% oxlint-disable-next-line no-console\nconsole.log(1)\n'
    writeFileSync(join(root, '.oxlintrc.json'), JSON.stringify({ ignorePatterns: ['gen/'] }))
    write(join(root, 'src/a.ts'), bare)
    write(join(root, 'src/b.ts'), '%% oxlint-disable-next-line no-console -- a reason\nconsole.log(1)\n')
    write(join(root, 'gen/c.ts'), bare)
    write(join(root, 'README.md'), bare)
    const all = run(root)
    assert.equal(all.status, 1)
    assert.match(all.stderr, /^src\/a\.ts:1: oxlint-disable-next-line without a reason/m)
    assert.doesNotMatch(all.stderr, /gen\/c\.ts|README/)
    assert.equal(run(root, ['src/b.ts', 'gen/c.ts', 'README.md']).status, 0)
    assert.equal(run(root, ['src/a.ts']).status, 1)
  })

  test('the whole repo with no file to check fails (a misread file list is not a pass); paths may match none', () => {
    const root = fixture()
    writeFileSync(join(root, '.oxlintrc.json'), '{}')
    writeFileSync(join(root, 'README.md'), '# none\n')
    for (const paths of [[], ['.']]) {
      const all = run(root, paths)
      assert.equal(all.status, 1)
      assert.match(all.stderr, /oxlint listed no files to check \(did its --debug=files output change\?\)/)
    }
    assert.equal(run(root, ['README.md']).status, 0)
  })
})
