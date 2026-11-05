# Development

Use the Bun scripts in package.json. Bootstrap with `bun install --frozen-lockfile`
and run `bun run setup` to prepare tools and install the owned Git hooks. OMP
is not required. `bun run check` calls the managed pre-push gate: dependency
consistency, formatting, lint, strict typing and unit tests with coverage.
`bun run lint-fix`, `bun run format` and `bun run typecheck` use the same services
as the extension. Run managed tests with `bun scripts/development.ts test` or
`bun scripts/development.ts integration`; `--test-file` accepts exact relative
paths and `--timeout-seconds` sets the execution budget. Feature aliases overlap;
do not combine them as the full gate. `bun run test:cost` runs both lanes once.

The tracked `.justomp/config.json` owns this repo's policy. Standard native tool configs are tracked project files; preparation updates their
managed fields. Runtime receipts and reports remain ignored. Keep the repo-only `.private/**` exclusions and
`skipLibCheck` exception; do not weaken shared rules or the 70% unit threshold.
Hooks own routine verification; do not repeat a passing full gate without new
changes or an unresolved failure. Setup preserves hook conflicts and may report
partial installation. It does not add a commit-msg hook.

Before adding or reviewing tests, read
[the test evidence and cost rule](compound-packs/testing/test-evidence-and-cost.md).
Every expensive integration test needs a real-boundary justification and a
measured setup cost. Pure decision/error permutations belong in units; preserve
real filesystem, process and native-tool proofs. Name replacement evidence
before removing a test. This rule also applies during direct work and CE's
lite/focused review paths, which do not automatically load packs.

Private execution notes belong in `.private/`. Compound Engineering artifacts
belong in `.compound-engineering/artifacts/`. Never publish without the user's
approval for that publication.
