// The shared commitlint config, shipped as `@tilr-dev/plugin/commitlint`: Conventional Commits with
// the repo standard's types, and no AI attribution in the message. A repo's commitlint.config.js:
//
//   export { default } from '@tilr-dev/plugin/commitlint'
//
// `tilr-plugin hook commit-msg` (lefthook's commit-msg) runs commitlint with it, or with this file
// when the repo has no config of its own.
import conventional from '@commitlint/config-conventional'
import conventionalCommits from 'conventional-changelog-conventionalcommits'

// The parser options as an object, imported from here (a dependency of this package), not a
// preset name the repo would have to resolve: a plugin repo has it only through this package.
// They parse `feat!:` and `BREAKING CHANGE:` like release-please does.
const parserPreset = { parserOpts: (await conventionalCommits()).parser }

/** The types a commit may have (the repo standard, §5); `revert` for `git revert`. */
export const TYPES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'ci', 'perf', 'revert']

/** Lines an agent or a tool appends to say who wrote the commit: not wanted (§5). */
export const AI_ATTRIBUTION = [
  /generated (with|by) .*(claude|chatgpt|copilot|cursor|codex|gemini|ai\b)/i,
  /co-authored-by:.*(claude|anthropic|chatgpt|openai|copilot|cursor|codex|gemini|devin|noreply@.*\bai\b)/i,
  /🤖/u,
]

/** A commitlint rule: fails when the message carries an AI attribution line. */
const noAiAttribution = ({ raw = '' }) => {
  const hit = AI_ATTRIBUTION.find(pattern => pattern.test(raw))
  return [!hit, 'no AI attribution lines ("Generated with …", an agent\'s Co-Authored-By) in commits']
}

/** commitlint's severities, and the line length conventional's config allows. */
const [WARNING, ERROR] = [1, 2]
const MAX_LINE = 100

export default {
  parserPreset,
  plugins: [{ rules: { 'no-ai-attribution': noAiAttribution } }],
  rules: {
    ...conventional.rules,
    'type-enum': [ERROR, 'always', TYPES],
    // Bodies quote URLs and logs; long lines there are a nudge, not a failure.
    'body-max-line-length': [WARNING, 'always', MAX_LINE],
    'footer-max-line-length': [WARNING, 'always', MAX_LINE],
    'no-ai-attribution': [ERROR, 'always'],
  },
}
