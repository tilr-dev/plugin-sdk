// `node tools/disable-comments.mjs [paths…]`, run by the lint step of `tilr-plugin verify` and of
// the pre-commit hook: turning a lint rule off says which rule and why (the repo standard, §3).
//
//   // oxlint-disable-next-line no-console -- the CLI's output is its interface
//
// Every `oxlint-disable`, `oxlint-disable-line`, `oxlint-disable-next-line` (and the `eslint-…`
// spellings, which oxlint honours too), as a line or a block comment, needs the rules it turns
// off and a ` -- reason` after them. oxlint itself reports a disable that suppresses nothing
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
const QUOTES = new Set(["'", '"', '`'])
/** A `/` after one of these (or at the start) begins a regex literal, not a division. */
const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^'])
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield'])
const KEYWORDS_MORE = new Set(['await', 'delete', 'throw', 'new', 'instanceof'])
/** The directive at the start of a comment, and what follows it. */
const DIRECTIVE = /^\s*((?:oxlint|eslint)-disable(?:-next-line|-line)?)(?=\s|$)([\s\S]*)$/
/** Between the rules and the reason: ` -- ` (ESLint's separator: two or more dashes, spaced). */
const SEPARATOR = /\s-{2,}(?:\s|$)/

/** The index after a quoted string or template starting at `i`. A '…' or "…" string ends at the
 *  line's end at the latest, so a quote misread elsewhere costs one line, not the file. */
function skipQuoted(source, i) {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    const c = source[j]
    if (c === '\\') j += 2
    else if (c === quote) return j + 1
    else if (c === '\n' && quote !== '`') return j
    else j++
  }
  return source.length
}

/** The index after a regex literal starting at `i` (a `/` inside […] does not end it). */
function skipRegex(source, i) {
  let inClass = false
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j]
    if (c === '\\') j++
    else if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '\n') return j
    else if (c === '/' && !inClass) return j + 1
  }
  return source.length
}

/** Whether a `/` whose last code character before it is at `prev` (-1: none) starts a regex. */
function regexAllowed(source, prev) {
  if (prev < 0 || BEFORE_REGEX.has(source[prev])) return true
  const word = /[\w$]+$/.exec(source.slice(0, prev + 1))?.[0]
  return !!word && (KEYWORDS_BEFORE_REGEX.has(word) || KEYWORDS_MORE.has(word))
}

/** The comment starting at `i` (`//` or `/*`): its text without the delimiters, and where it ends. */
function commentAt(source, i) {
  const block = source[i + 1] === '*'
  const close = block ? source.indexOf('*/', i + 2) : source.indexOf('\n', i)
  if (close === -1) return { text: source.slice(i + 2), end: source.length }
  return { text: source.slice(i + 2, close), end: block ? close + 2 : close }
}

/** `found` ([{ text, at }], in order) with the 1-based line of each `at` instead. */
function withLines(source, found) {
  let line = 1
  let counted = 0
  return found.map(({ text, at }) => {
    for (; counted < at; counted++) if (source[counted] === '\n') line++
    return { text, line }
  })
}

/** The comments of a JS/TS source: [{ text, line }], `text` without the comment's delimiters,
 *  `line` 1-based where the comment starts. Strings, templates and regex literals are skipped,
 *  so `'// oxlint-disable'` in a string is not a comment. */
export function comments(source) {
  const found = []
  /** The last character of code before `i`: whether a `/` there divides or starts a regex. */
  let prev = -1
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const { text, end } = commentAt(source, i)
      found.push({ text, at: i })
      i = end
      continue
    }
    let end = i + 1
    if (QUOTES.has(c)) end = skipQuoted(source, i)
    else if (c === '/' && regexAllowed(source, prev)) end = skipRegex(source, i)
    if (end > i + 1 || !/\s/.test(c)) prev = end - 1
    i = end
  }
  return withLines(source, found)
}

/** A disable directive in a comment's text: { kind, rules, reason }, or null for other comments. */
export function parseDirective(text) {
  const match = DIRECTIVE.exec(text)
  if (!match) return null
  const [rules, ...reason] = match[2].split(SEPARATOR)
  return { kind: match[1], rules: rules.trim(), reason: reason.join(' ').trim() }
}

/** What is wrong with the disable comments of `source`: [{ line, message }]. */
export function problems(source) {
  const found = []
  for (const { text, line } of comments(source)) {
    const directive = parseDirective(text)
    if (!directive) continue
    const { kind, rules, reason } = directive
    if (!rules) found.push({ line, message: `${kind} names no rule: list the rules it turns off` })
    if (!reason) {
      found.push({ line, message: `${kind} without a reason: write it as "${kind} <rule> -- <why>"` })
    }
  }
  return found
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

/** `file:line: problem` for each disable comment without its rules or reason in `files`. */
export function check(files, { root = process.cwd(), read = file => readFileSync(join(root, file), 'utf8') } = {}) {
  return files.flatMap(file => problems(read(file)).map(({ line, message }) => `${file}:${line}: ${message}`))
}

/** The CLI: checks `paths` (or the whole repo) in `root`; resolves to the exit status. */
export function main(paths, { root = process.cwd(), log = console.error } = {}) {
  const found = check(lintedFiles(paths, root), { root })
  for (const problem of found) log(problem)
  if (found.length) log(`\n${found.length} disable comment(s) without the rule or the reason (" -- why")`)
  return found.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
