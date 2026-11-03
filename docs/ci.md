# Repository CI

Justomp's own GitHub workflow is `.github/workflows/ci.yml`. Every PR runs the complete managed gate and integration suite on `ubuntu-24.04` (x64) and `macos-15` (ARM64). Documentation-only, draft and Dependabot PRs use the same checks. A newer PR revision cancels its older run; failure on one operating system does not cancel the other.

The workflow uses the proposed merge revision supplied by `pull_request`. It does not run another complete suite when the PR is merged into `main`.

## Checks

Each platform installs root dependencies with `bun install --frozen-lockfile`, then runs:

```sh
bun run check --report "$RUNNER_TEMP/justomp-ci/check.json"
bun run check:integration --report "$RUNNER_TEMP/justomp-ci/integration.json" --timeout-seconds 1800
```

`check` runs lock consistency, preparation, format check, lint, strict typing and full unit tests with the configured 70% coverage minimum. Integration coverage remains disabled. CI does not run autofixes or install local Git hooks. The repo-only format policy excludes generated `biome.justomp.jsonc` and `tsconfig.justomp.*.json` projections; source files and the typecheck policy remain checked. Integration still runs after a failed check when native setup succeeded and the run was not cancelled; either failure leaves the platform unsuccessful.

The 45-minute job limit and 1800-second integration deadline are resource ceilings for cold runners, not performance targets. Individual native fixtures have their own deadlines. Command logs include wall time, and setup reports its own duration. Compare cold and warm runs on the same platform/toolchain; do not replace the local test-cost baseline with hosted-runner times or run the overlapping test aliases as additional full gates.

## Fresh preparation and checkout changes

A fresh checkout has no managed readiness state. Normal preparation resolves latest managed tools and can update `package.json`, `bun.lock` or the shared config. Frozen dependency installation does not suppress that later preparation.

CI records Git state before installation and after installation, managed checks and integration tests. Tracked changes, staged changes and nonignored untracked files fail the run. Earlier observations stay failed even if a later command makes the tree clean. Git-ignored cache/coverage outputs do not fail this check. CI never restores files or commits generated updates automatically.

When preparation changes metadata, run the normal managed preparation locally, inspect the resulting diff and commit the intended update to the PR. A passing test result with an uncommitted dependency update is insufficient.

## Native environment

The workflow pins Bun 1.4.2, Node 26.0.0, Python 3.13.13, uv 0.11.6 and Go 1.25.6. `scripts/ci/setup.ts` derives package manager versions from `tests/fixtures/dependencies/manager-versions.json`, and derives the separate modern Yarn typecheck version from its fixture owner.

| Manager      | Version | Purpose                                                |
| ------------ | ------- | ------------------------------------------------------ |
| npm          | 11.12.1 | Native npm fixtures and launcher bootstrap             |
| pnpm         | 10.20.0 | Native pnpm fixtures and PATH-based adapter resolution |
| Yarn Classic | 1.22.22 | Classic lock/installation handoffs                     |
| Yarn Modern  | 4.12.0  | Dependency/lint handoffs                               |
| Yarn Modern  | 4.18.1  | Distinct TypeScript fixture handoff                    |

Installations live under `$RUNNER_TEMP/justomp-tools`, outside the checkout. Version probes run from a neutral directory so package managers do not reject this repo's Bun `packageManager` field. The helper exports the four existing `JUSTOMP_*_BINARY` fixture inputs and places npm/pnpm launchers on PATH. It does not change a developer's global tools.

Linux explicitly installs bubblewrap and enables the required unprivileged-user-namespace setting if the ephemeral runner's AppArmor policy restricts it. Both platforms exercise Justomp's real sandbox command: an ordinary write must work and a protected write must fail without changing its file. Missing capabilities fail setup; there is no unsandboxed fallback. macOS requires `/usr/bin/sandbox-exec`.

Native fixtures install their own compiler/linter/framework packages. Some testing fixtures resolve current pytest/Vitest versions. Public registry/release access and loopback servers are needed; production services, OMP model credentials and repository secrets are not.

For a local setup rehearsal, first provide the pinned runtimes and a temporary `RUNNER_TEMP`, `GITHUB_ENV` file and `GITHUB_PATH` file. Run `bun scripts/ci/setup.ts configure`, restore any desired download cache, then `bun scripts/ci/setup.ts`. The exported environment and PATH must be applied to subsequent commands; GitHub Actions does this automatically. A plain local shell does not. For ordinary local tests, follow the existing [native dependency setup](dependencies.md#reproducing-native-tests) and [typecheck fixture setup](typecheck.md).

## Download cache

Cache entries contain only `$RUNNER_TEMP/justomp-downloads` and Go's `cache/download` subtree. Installed dependencies, virtual environments, managed readiness, fixture projects, module extraction/build results and passing test reports are not restored. The key includes operating system, architecture, runtime/manager inputs and root lock content. Every cache hit still performs installation and all validation.

npm/pnpm download defaults use a disposable user config, allowing fixture-local config to keep its isolated registry/cache choices. Other fixtures retain their existing explicit overrides. No default-branch cache warmer is installed: a cache saved by a PR belongs to that PR's merge ref and cannot warm unrelated PRs. Cache misses and unavailable fork cache saves affect speed, not required proof.

## Diagnostics

Each platform uploads a separate artifact with seven-day retention. The explicit file allowlist contains:

- Runtime/image versions and native setup outcome in `environment.json`.
- Initial Git revision and the three checkout observations.
- Installation, setup, check and integration logs with command timing.
- Managed check/integration JSON receipts and the combined CI summary when available.

Reports stay under `$RUNNER_TEMP/justomp-ci`, outside source discovery. Collection runs after success or failure when setup created the output directory; cancelled runs need not finish uploading. Early setup failures may have only GitHub step logs. The original command failure is never converted to success by artifact upload.

No whole `.private`, `.justomp`, fixture tree, authentication directory or environment dump is uploaded. Raw JUnit/LCOV files are not promised: the existing test service removes those temporary artifacts. Managed JSON receipts retain counts, coverage and case results.

## Activating the merge gate

The workflow file alone does not configure repository protection. After an authorized first PR has produced both real results:

1. Verify access to the intended repository, Actions permissions and support for protected branches under its visibility/GitHub plan.
2. Observe the actual check contexts for the `Justomp CI` workflow's `Linux` and `macOS` jobs.
3. Require both checks on `main`, select GitHub Actions as their source where available, require an up-to-date PR branch, and prevent routine direct pushes/bypasses. Preserve unrelated existing protections.
4. Verify the settings and both passing current-revision runs before declaring enforcement active.

When `main` advances, update the PR branch and rerun validation before merging. Fork contributors may require GitHub's workflow approval; this does not waive the checks. Repository creation, visibility changes and remote policy changes require the maintainer's explicit approval.

Local implementation or a local passing suite does not establish that hosted runs or branch protection are active. Record the actual run URLs and rule read-back when activating them.
