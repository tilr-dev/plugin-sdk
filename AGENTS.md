# Working in the plugin SDK (`@tilr-dev/plugin`)

This repo is the kit every Tilr plugin repo builds, checks and tests against: the plugin API's
types (`api/`), the build and CLI (`tools/`), the e2e harness (`test/harness.ts`), and the shared
configs and checks (`eslint.base.js`, `presets/`, `tilr-plugin verify`). It is **public**: what
you commit is published. README.md says what is where; docs/ has the details.

## Before every commit

- **`npm run verify` must be green.** It is the same pipeline the pre-push hook and CI run
  (format, lint, types, api, unit, dupes, unused, secrets, deps); green here means green there.
  `npm run verify:full` adds `npm pack --dry-run` (and e2e, when there are any).
- `npm run format` fixes formatting (Biome, format only). Lint findings are fixed, not silenced.
- The hooks are installed by `npm install` (lefthook). Do not bypass them with `--no-verify`.

## Commits

- **Conventional Commits**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`,
  optional scope (`fix(build): …`), `!` or a `BREAKING CHANGE:` footer for a break; footers
  `Refs: #N` / `Closes: #N`. commitlint checks it (commit-msg hook).
- **No AI attribution**: no "Generated with …" lines, no agent `Co-Authored-By`. commitlint
  rejects them.
- Small commits, one logical change each. Work in short branches (`feat/12-short-name`), PRs are
  squash-merged into `master`, which stays green and releasable. Releases are release-please's.

## Code

- No `any`, no non-null `!`, no `@ts-ignore` / `@ts-expect-error` without a reason; no floating
  promises. Complexity ≤ 15, depth ≤ 4, params ≤ 4.
- An `eslint-disable` needs a description: `// eslint-disable-next-line rule -- why`. An unused
  one is an error. Disable one line for a real reason, never a file to make a warning go away.
- `api/` is the plugin contract: it changes only through `npm run api:sync` from the core repo,
  with a `tilrApi` bump in a `feat` commit (README, Keeping api/ and site/ in sync, Versions).
  `site/` changes only through `npm run sync:runtime`. CHANGELOG.md is release-please's.
- What ships to plugin repos (`presets/`, `eslint.base.js`, `tools/verify.mjs`, `tools/init-plugin.mjs`)
  changes every plugin's checks: say so in the CHANGELOG.

## Secrets

- Public repo: no tokens, keys, `.env` files, internal URLs or personal data, in code, tests,
  fixtures or commit messages. gitleaks scans staged changes (pre-commit) and the history
  (verify, CI). A false positive goes into `.gitleaks.toml` with a description, narrowly.
