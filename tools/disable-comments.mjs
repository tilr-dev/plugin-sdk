// `node tools/disable-comments.mjs [paths…]`, run by the lint step of `tilr-plugin verify` and of
// the pre-commit hook: turning a lint rule off says which rule and why, and never for a whole
// file (the repo standard, §3).
//
//   // oxlint-disable-next-line no-console -- the CLI's output is its interface
//
//   /* oxlint-disable max-lines -- the generated table below */
//   …
//   /* oxlint-enable max-lines */
//
// Every `oxlint-disable`, `oxlint-disable-line`, `oxlint-disable-next-line` (and the `eslint-…`
// spellings, which oxlint honours too), as a line or a block comment, needs the rules it turns
// off and a ` -- reason` after them. An `oxlint-disable` (a range, not one line) needs a later
// `oxlint-enable` of the same rules: a disable left open to the end of the file is a whole-file
// disable, which is not allowed. An enable of a rule that is not disabled, and a disable of a rule
// that already is, are problems too. oxlint itself reports a disable that suppresses nothing
// (`reportUnusedDisableDirectives` in the preset); this is the part it has no rule for.
//
// The files are the ones oxlint lints (`oxlint --debug=files`, with the repo's .oxlintrc.json
// and .gitignore): all of them without paths, else those of `paths` it does not ignore. Prints
// `file:line: problem` for each and exits 1 when there is any.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageBin } from './verify.mjs'

const KIT = fileURLToPath(new URL('..', import.meta.url))
/** A directive: a comment opener (`//`, `/*`, `/**`), then the directive right after it (a block
 *  comment's may be on a later line). No tokenizer: a JS/TS/JSX scanner that tells comments from
 *  strings, regex literals, divisions and JSX text misses real directives where it guesses wrong.
 *  This errs the other way: a string holding a comment opener and then a directive counts too,
 *  and fails loudly; split the string between the two (the tests spell the opener `%%`). */
const DIRECTIVE = /(\/\/[ \t]*|\/\*\*?\s*)((?:oxlint|eslint)-(?:disable(?:-next-line|-line)?|enable))(?![\w-])/g
/** Between the rules and the reason: ` -- ` (ESLint's separator: two or more dashes, spaced). */
const SEPARATOR = /\s-{2,}(?:\s|$)/
/** A range disable's or enable's rule list that names none: all rules. */
const ALL = ''

/** A directive's text after its kind: the rest of the line, or of the block comment. */
function bodyAt(source, start, block) {
  const end = block ? source.indexOf('*/', start) : source.indexOf('\n', start)
  return source.slice(start, end === -1 ? source.length : end)
}

/** A directive's rules and reason from the text after its kind ({ rules: '', reason: '' } if none). */
export function parseBody(body) {
  const [rules, ...reason] = body.split(SEPARATOR)
  return { rules: rules.trim(), reason: reason.join(' ').trim() }
}

/** The directives of a source: [{ kind, rules, reason, line }], in order, `line` 1-based where
 *  the directive's kind is. */
export function directives(source) {
  const found = []
  let line = 1
  let counted = 0
  for (const match of source.matchAll(DIRECTIVE)) {
    const at = match.index + match[1].length
    for (; counted < at; counted++) if (source[counted] === '\n') line++
    const body = bodyAt(source, at + match[2].length, match[1].startsWith('/*'))
    found.push({ kind: match[2], ...parseBody(body), line })
  }
  return found
}

/** The rules a range directive names, ALL for none. */
const ruleList = rules => (rules ? rules.split(',').map(rule => rule.trim()) : [ALL])
/** A rule as a message names it. */
const named = rule => (rule === ALL ? '(all rules)' : rule)
const isEnable = ({ kind }) => kind.endsWith('-enable')

/** A disable's missing rules or reason: [{ line, message }]. */
function undescribed({ kind, rules, reason, line }) {
  const found = []
  if (!rules) found.push({ line, message: `${kind} names no rule: list the rules it turns off` })
  if (!reason) found.push({ line, message: `${kind} without a reason: write it as "${kind} <rule> -- <why>"` })
  return found
}

/** Opens the rules of the range disable `directive` in `open` (rule -> its disable). */
function disable(directive, open, found) {
  for (const rule of ruleList(directive.rules)) {
    const earlier = open.get(rule)
    if (earlier) {
      const message = `${directive.kind} ${named(rule)}: already disabled at line ${earlier.line}`
      found.push({ line: directive.line, message })
    } else open.set(rule, directive)
  }
}

/** Closes the rules of the enable `directive` in `open`: all of them for one that names none. A
 *  rule enabled inside a disable of all rules is fine (it turns that one back on). */
function enable({ kind, rules, line }, open, found) {
  const list = ruleList(rules)
  if (list[0] === ALL && open.size) return open.clear()
  for (const rule of list) {
    if (!open.delete(rule) && !(rule !== ALL && open.has(ALL))) {
      found.push({ line, message: `${kind} ${named(rule)} without a preceding disable: nothing to enable` })
    }
  }
}

/** The range disables of `list` left open to the end of the file, and the enables and repeated
 *  disables that do not pair up: [{ line, message }]. */
function unpaired(list) {
  const found = []
  const open = new Map()
  for (const directive of list) {
    if (isEnable(directive)) enable(directive, open, found)
    else if (directive.kind.endsWith('-disable')) disable(directive, open, found)
  }
  for (const [rule, { kind, line }] of open) {
    const enabler = `${kind.replace(/disable$/, 'enable')} ${rule}`.trim()
    found.push({
      line,
      message: `${kind} ${named(rule)}: disable without a matching enable (whole-file disables are not allowed); end the range with "/* ${enabler} */"`,
    })
  }
  return found
}

/** What is wrong with the disable comments of `source`: [{ line, message }], by line. */
export function problems(source) {
  const list = directives(source)
  const found = [...list.filter(d => !isEnable(d)).flatMap(undescribed), ...unpaired(list)]
  return found.sort((a, b) => a.line - b.line)
}

/** The files oxlint lints of `paths` (all of the repo's with none), relative to `root`. */
export function lintedFiles(paths, root) {
  const oxlint = packageBin('oxlint', 'oxlint', [root, KIT])
  if (!oxlint) throw new Error(`oxlint is not installed (npm install in ${root})`)
  const args = [oxlint, '--debug=files', '--no-error-on-unmatched-pattern', ...(paths.length ? paths : ['.'])]
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  if (child.status !== 0) throw new Error(`oxlint --debug=files failed:\n${child.stderr || child.stdout}`)
  return child.stdout.split('\n').filter(Boolean)
}

/** `file:line: problem` for each disable comment problem in `files`. */
export function check(files, { root = process.cwd(), read = file => readFileSync(join(root, file), 'utf8') } = {}) {
  return files.flatMap(file => problems(read(file)).map(({ line, message }) => `${file}:${line}: ${message}`))
}

/** The CLI: checks `paths` (or the whole repo: none, or `.`) in `root`; resolves to the exit
 *  status. No file to check in the whole repo means oxlint's file list was misread: a failure,
 *  not a pass. */
export function main(paths, { root = process.cwd(), log = console.error } = {}) {
  const files = lintedFiles(paths, root)
  if (!files.length && paths.every(path => path === '.')) {
    log('oxlint listed no files to check (did its --debug=files output change?)')
    return 1
  }
  const found = check(files, { root })
  for (const problem of found) log(problem)
  if (found.length) log(`\n${found.length} disable comment problem(s) (tools/disable-comments.mjs)`)
  return found.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
