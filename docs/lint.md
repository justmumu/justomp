# Project lint, fixes and format checks

`project_lint` checks one inspected project with the repository's shared policy. Python uses Ruff; JavaScript/TypeScript uses Biome for linting and Prettier for formatting; Go uses golangci-lint with gofumpt and goimports. Both lint and format checks must pass. Source fixing is opt-in through `fix: true`; omitted or false keeps the check-only behavior.

## Selecting a project

Call `list_projects({})`, then pass one returned ID:

```json
{"project_id":"python:pyproject.toml"}
{"project_id":"javascript:apps/web/package.json"}
{"project_id":"go:services/api/go.mod"}
```

These are three separate `project_lint` calls. The tool requires `project_id` and accepts optional boolean `fix` (default false); it rejects ecosystem, manager, command, working-directory, files and rule inputs. Moving a manifest changes its ID. An unknown ID is rejected before that call starts native preparation.

OMP registers the tool at the `exec` approval tier. Its JSON result appears in model-readable `content` and in `details`. Denying the tool prevents its body from running. It does not prevent the separately enabled session-start lifecycle from preparing tools.

`lint.javascript.exclude` accepts an array of project-relative glob patterns, including dot paths, and defaults to `[]`. For example, `[".private/**"]` omits unimported private archives from selected JS/TS source entries. Explicit arrays replace the default; `[]` restores the ordinary owned-source scope. Changing exclusions requires preparation and invalidates the corresponding readiness evidence.

Lint and typecheck exclusions are independent. They do not change test selection or coverage ownership, and cannot include dependency directories, generated state, symlinks or child projects excluded by ordinary ownership rules. They are source-entry filters, not filesystem or import-security boundaries: TypeScript may still analyze an excluded file imported by selected code. Diagnostics are not hidden after checking.

## Applying lint fixes

```json
{"project_id":"python:pyproject.toml","fix":true}
{"project_id":"javascript:apps/web/package.json","fix":true}
```

These are separate calls. Each waits for normal preparation, fixes only the selected project's current lint scope, then runs the ordinary lint and format checks under the same project lease. It uses already prepared native tools; requesting fixes does not itself upgrade their versions. Startup preparation never fixes source files.

- Python runs Ruff with `--fix --no-fix-only --no-unsafe-fixes`. The root policy's fixable/unfixable restrictions and safety demotions still apply. A nonempty or malformed `extend-safe-fixes` list, including its legacy top-level spelling, produces `unsupported-safe-fix-config` before source writes. Explicit `extend` inheritance also prevents fixing because inherited safety promotions have not been verified. Check-only remains available and the policy is not rewritten.
- JS/TS runs Biome `check --write` with formatting disabled and import organization enabled according to the shared policy. It never passes `--unsafe`. A rule-level `fix: "safe"` in an active policy map produces `unsupported-safe-fix-config` because it can promote an upstream unsafe fix. Read-only checking remains available. Native safe classifications are not an absolute guarantee of preserved runtime behavior.
- Go returns `fix.status: "unsupported"` and runs normal checks. Unsupported autofix alone does not fail otherwise passing checks. Use `project_format` for Go formatting and imports.

Lint fixing does not run a formatter in write mode. A fix can therefore change source while the subsequent format check still fails; use `project_format` separately. Native lint autofixes may themselves adjust style or imports according to enabled lint rules.

Only a fix request adds `fix` to the result. It contains `requested`, `supported`, `status`, sorted repository-relative `changed_files`, `observation_complete` and `errors`, with native execution details when a process ran. Status is `completed`, `unsupported`, `not-run`, `failed` or `cancelled`. A resolved empty source scope uses `not-run` with reason `no-sources` and retains the ordinary non-passing no-sources result. Before a target is resolved, `supported` is null.

Completed fixes do not imply a clean project: final `checks` and `diagnostics` describe the post-fix state and decide success. Native exits 0 and 1 can permit rechecking; Biome also requires a complete diagnostic report, so an exit code alone never proves a completed fix. Operational failures, cancellation, truncated output or incomplete file observation stop further checks. The tool waits for process cleanup and observes source differences before releasing the lease. Completed edits are retained on failure; there is no rollback.

If a source disappears or cannot be safely read afterward, `observation_complete` is false and errors identify the affected path. Known changed paths remain visible. A false `partial_change` with incomplete observation does not prove nothing changed. The lease coordinates Justomp calls, not external editors; reported changes are observed differences rather than exclusive attribution to the fixer.

## Preparation and lifecycle

After startup inspection completes, the extension starts tracked background preparation outside the inspection handler's 24-second deadline. Lint/format preparation installs Justomp-owned tools and reconciles managed native configuration; it does not add project lint dependencies or change dependency groups, `packageManager`, scripts or locks. Full startup also prepares typecheck and testing, which can still install project packages, change manifests/locks and run native lifecycle scripts under the package manager's existing policy. Enabling the plugin authorizes this trusted lifecycle code; OMP tool approval does not sandbox it.

A discovered manifest makes a new project eligible for preparation. An empty folder does not. The coordinator also watches the exact `.justomp/config.json` path, without including hidden directories in ordinary discovery. A `project_lint` call waits for preparation or retries it before checking its selected project. Progress and completion/failure reports appear in the OMP UI or headless console, including the projects that preparation may affect.

The inspection getter itself never installs tools. Without a healthy watcher, automatic background discovery is not guaranteed; the next explicit lint call rechecks the current structure. There is no polling timer, periodic latest-version query, daemon or persisted `BUSY` lock.

Preparation and checks share the dependency tools' process-local resource queue. A check verifies its environment before and after execution. Cancellation closes native processes before releasing their queue lease. Cancelling a tool's wait can leave shared preparation running for another active session; the cancelled result says its effects are not yet final. Closing the last owning session cancels and joins preparation. Root changes release the old root before using the new one.

Readiness receipts persist in `.justomp/lint_state.json`. They bind the current Justomp tool provider, ecosystem and release pin, together with policy, native configuration ownership and project membership. Receipts alone never establish readiness: executables and projected configuration are checked again. Old receipts without the current tool identity are stale; preparation revalidates them without discarding healthy installations or unrelated state.

New projects join the current release-pinned tool group; discovery does not query remote latest. Current membership and every member's target must be verified before lint or native formatting proceeds. Policy/config-only repair does not reinstall a healthy executable. Check-only calls fail explicitly on stale readiness without downloading tools or repairing configuration.

Downloaded tool pins live in `src/lint/toolchain.ts`: Ruff **0.17.3** and golangci-lint **2.15.0**. Runtime npm versions come from Justomp's `package.json`: Biome **2.6.5**, Prettier **3.9.10** and the TOML plugin **2.0.6**. These pins change with a Justomp release, not project discovery. Typecheck and test-runner version policies are unchanged.

### Python versions

Ruff is a standalone executable downloaded from the official release with SHA-256 verification, version validation and atomic publication. It lives below the repository root at `.justomp/tools/ruff/<version>/<platform>/ruff`; this is a repository-local cache, not a shared global installation. Supported download targets are Darwin/Linux on x64/arm64.

Isolated Python lint/format requires neither Python nor uv. Justomp does not consult PyPI metadata or select Ruff from the project environment or `PATH`. Managed Ruff fields in `ruff.toml`, `.ruff.toml` or `pyproject.toml` are still reconciled; that configuration ownership does not authorize dependency changes.

### JavaScript and TypeScript versions

Biome comes from Justomp's runtime dependencies. Justomp resolves the official native platform optional package relative to its own installed package and invokes the executable directly under the Bun-hosted extension. It does not use the Node wrapper, child `node_modules`, PnP or `PATH` to find a lint executable. Missing optional packages fail explicitly rather than falling back to a project/global binary. Platform selection stays within Darwin/Linux x64/arm64; it adds no Windows or musl support guarantee.

All managed JavaScript, TypeScript, JSX, TSX, React and Next.js projects use this engine. Biome does not depend on the typescript-eslint compiler API, and lint preparation neither installs nor downgrades TypeScript. This removes that compiler-peer coupling; it does not promise that Biome supports every future TypeScript syntax feature. Native parser failures are reported as source diagnostics. [Project typechecking](typecheck.md) remains a separate service with its own compiler preparation.

Prettier is bundled with Justomp and shared with [project_format](format.md). Its settings come from `format.prettier`, with per-attribute fallback to legacy `lint.javascript.prettier` and then defaults. Lint does not install or verify a target Prettier package; existing user dependencies remain untouched. Biome's formatter is disabled for both checking and fixing.

### Legacy lint dependencies

Existing Ruff and Biome declarations and lock entries remain untouched because Justomp has no reliable record of who added them. Their versions and presence no longer select lint/format tools. A readiness receipt is not dependency provenance.

If these packages are no longer needed by the project, review their other uses and remove them explicitly with the existing `dependency_remove` tool and the project's native dependency workflow. This optional cleanup is separate from normal preparation and must keep locks consistent. Do not remove TypeScript, Pyright or test-runner packages as lint leftovers. Native managed configuration fields still reconcile even when they share a manifest with retained dependencies.

### Migrating existing JavaScript policy

The active policy is `lint.javascript.biome`. Justomp translates the previously shipped `lint.javascript.eslint` defaults automatically. The old data remains in the shared config for reference but no longer affects effective policy hashes or execution. Explicit native Biome settings are authoritative; missing native attributes receive defaults rather than being filled from archived ESLint data.

Supported custom legacy settings and explicit disablements are translated without executing `eslint.config.*`. Empty legacy rule maps remain empty. Shipped disabled core rules defer to their supplied TypeScript replacements; JSON key order does not change that result. If a customized rule, option, global permission or conflicting mapping cannot be translated reliably, preparation identifies the legacy config path and preserves the original file without a partial rewrite. Provide the corresponding native Biome policy or remove that customization. Known gaps in the shipped default policy do not block migration.

Preparation publishes standard native configs, saves their managed-field ownership, then removes legacy Justomp config copies only when their ownership markers and observed contents still match. Unowned legacy files remain untouched. Existing dependency declarations also remain: a readiness receipt does not establish who installed a package. Justomp stops managing and executing ESLint; it does not infer permission to remove these packages:

- `eslint`, `@eslint/js`, `typescript-eslint`
- `eslint-plugin-simple-import-sort`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `@next/eslint-plugin-next`

Review those declarations before removing them explicitly through dependency tools. Do not remove the application's TypeScript dependency as a lint leftover.

### Rule differences

The strict Biome baseline is an explicit rule snapshot. Automatic recommended/domain rule selection stays disabled, so upgrading Biome does not silently enable a new preset. Base, typed, framework and test maps apply in that order; React/Next maps apply only to matching projects. The [full migration inventory](lint-migration.md) records all 225 prior entries, including disabled overrides: 150 named counterparts, 41 partial mappings and 34 entries without a verified equivalent. Named counterparts do not imply identical semantics.

Notable differences include:

- Cognitive complexity uses a limit of 10; this is a different metric from the old cyclomatic complexity limit.
- Import organization uses Biome's assist rather than simple-import-sort's ordering.
- Unsafe argument/assignment/call/member-access checks, unbound methods, template-expression restrictions and several Next-specific checks have no verified equivalent in the baseline.
- `noTsIgnore` does not reproduce the old ten-character suppression-explanation requirement.
- Biome's native type analysis differs from TypeScript/typescript-eslint. Strict typechecking continues separately, but is not claimed to replace missing lint rules.

Unsupported rules are omitted rather than emulated or used to reinstall ESLint. Supplied native options retain Biome's own semantics.

### Go versions and readonly execution

Preparation uses the release-pinned golangci-lint **2.15.0**, verifies the official archive's SHA-256 checksum and version, and atomically publishes the binary below `.justomp/tools/golangci-lint/<version>/<platform>/`. It does not add a Go application dependency or query latest. The installed Go version and the binary's build Go version must support the project/workspace requirement. Compatible Go and application dependencies remain required; no toolchain download or upgrade is performed.

One `golangci-lint run` checks linters and enabled formatters. The adapter separates diagnostics by their linter/formatter names; the lint check never invokes `fmt` or enables `--fix`. Native compiler/type-analysis failure leaves both stages `not-run`. See the [native CLI commands](https://golangci-lint.run/docs/configuration/cli/).

Checks disable module downloads and use readonly module metadata. Go's workspace mode can still write `go.work.sum`; the native Go 1.25.6 tests reproduce this behavior. The adapter copies the workspace description and sums to a temporary directory, rebases member/replacement paths with native `go work edit -print`, and removes the copy after the process closes. Original modules, workspace files and sources stay unchanged. Go's [workspace requirement commit path](https://go.dev/src/cmd/go/internal/modload/init.go) explains why readonly mode alone is insufficient.

Missing dependencies require an explicit dependency sync before linting. golangci-lint's native runner lock remains in force; external contention is reported without deleting the lock. Configuration that redirects output, enables fixes or bypasses the runner lock is rejected.

## Shared configuration and owned files

The repository-root `.justomp/config.json` is the single policy source. There is one `lint.python`, `lint.javascript` and `lint.go` policy, applied to every corresponding project. There are no project-specific policy overrides.

All config attributes are optional. Startup and explicit preparation fill absent attributes. Structural objects are completed recursively; arrays and user-keyed maps such as `rules`, `typed_rules` and Python per-file ignores replace defaults as whole values. Empty arrays/maps remain empty. Unknown fields survive completion; invalid known types fail without a default being substituted.

`lint.javascript.biome` contains `rules`, `typed_rules`, `react_rules`, `next_rules` and `test_rules`, each using native group → rule → severity/options maps. Every supplied map is atomic, including `{}`. `globals` is an array of names; `organize_imports` is `"on"`, `"off"`, or a native `{ "level": ..., "options": ... }` setting. Unrelated unknown fields are preserved as data but are not spread into generated native config. Config redirection, plugins and file-scope overrides are not accepted policy fields.

```json
{
  "lint": {
    "javascript": {
      "biome": {
        "rules": { "suspicious": { "noDebugger": "error" } },
        "test_rules": {},
        "organize_imports": "off"
      }
    }
  }
}
```

This replaces the base rule map, keeps the test override empty and disables import organization. Other absent attributes receive defaults.

For example, this partial input keeps Python's ignore list empty and receives the other missing defaults:

```json
{
  "lint": {
    "python": {
      "ruff": {
        "lint": { "ignore": [] }
      }
    }
  }
}
```

The [inspection and lint default example](lint-defaults.json) records those sections of the root config. [Typecheck defaults](typecheck-defaults.json) occupy the same file’s `typecheck` section. A test compares this example with the code defaults. It includes the strict Ruff rule families, Google docstring convention, import rules and visible test/script exceptions. JS/TS defaults use explicit Biome base/typed rules, import organization, cognitive complexity 10, conditional React hooks/accessibility and Next rules, plus separate Prettier formatting. Go enables `govet`, `staticcheck`, `unused`, `errcheck`, `errorlint`, `gosec`, `bodyclose`, `contextcheck`, `exhaustive`, `revive`, `gocritic` and `cyclop`, with gofumpt/goimports formatting. Defaults use error severity; an explicit user warning retains the native tool's warning semantics.

| Project | Managed native configuration                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------- |
| Python  | Active `ruff.toml`/`.ruff.toml`, otherwise Ruff fields in `pyproject.toml`                                                |
| JS/TS   | Active `biome.json`/`biome.jsonc`; the native Prettier config or embedded package field, defaulting to `.prettierrc.json` |
| Go      | Active `.golangci.yml`, `.golangci.yaml`, `.golangci.toml` or `.golangci.json`; default `.golangci.yml`                   |

`.justomp/config.json` remains the policy source. Preparation updates managed fields and removes fields previously managed but now absent from policy. Project context, unrelated fields and comments are preserved where the native format permits it. Receipts record field ownership; standard files need no Justomp marker. Formatting-only changes do not require another publication.

Biome uses native nested configs within the selected project's scope. Separately discovered child projects retain their own policy. Prettier respects native filename precedence, including package-embedded configuration. Static JS/TS object and `defineConfig` exports can be edited without evaluating the module; imports, plugins and unrelated callbacks remain. Dynamic factories, conflicting native files or inheritance that cannot preserve policy produce an error naming the affected configuration.

Python source-layout and target-version metadata remain local. Ruff policy controls are reconciled with the shared policy. Unsafe inherited Pyright/Biome overrides require explicit adoption; preparation does not guess their intended semantics or overwrite another project's settings. Bundled Prettier still receives the resolved shared options directly; it does not load project plugins or editorconfig.

The lint source list is separate from `inspection_rules`. Checks include supported source extensions under the selected project, including ordinary hidden source files. They exclude dependency/build/cache directories, justomp outputs, symlinks and separately discovered child projects. Canonical custom uv environments and supported pnpm module/store destinations are excluded too. Parent checks do not lint a child project twice. Native Biome/Go analysis may still read dependencies needed to analyze the selected target.

A policy change must be projected before a check can succeed. Policy-only repair does not reinstall already verified tools. Checks do not write source, native config, manifest, lock or justomp state/snapshot files. Native caches and temporary Go workspace files are separate from those project files.

## Results and partial preparation

JavaScript lint checks report `tool: "biome"` and the selected `@biomejs/biome` version. Source lint, parse and import-assist diagnostics are distinct from setup/process failures. Malformed output, skipped files or unprinted diagnostics leave execution incomplete.

Each selected-project result includes `project_id`, `relative_path`, `ecosystem`, `policy_hash`, preparation effects and exact selected tool versions. `checks` contains separate lint/format entries with native exit code, duration, status and diagnostics. Diagnostic paths are repository-relative and project-relative where applicable.

Statuses are `passed`, `failed`, `not-run` and `no-sources`. An empty source scope is not a clean pass. Truncation, cancellation and failed readiness appear through `complete`, `truncated`, `cancelled`, `incomplete_stages` and `remediation`; an unfinished stage cannot produce `success: true`.

Preparation can affect more projects than the selected check. Its report includes affected IDs, actual changed metadata paths, errors and per-project receipts. Use per-project receipts for versions when projects have different tool sets. There is no rollback of completed native changes.

An unrelated ecosystem's setup error does not prevent a ready selected project from passing. In that case the result can have `success: true` while `preparation.complete` is false; the preparation errors and effects remain visible. `partial_change` means incomplete preparation left reported changes, or an incomplete fix/check call left observed source changes. Remaining lint violations from completed checks do not alone make changes partial. Python success still requires every member of the current Python tool group to be verified.

## API, CLI and CI

The public API works without OMP:

```ts
import { checkProjectLint, prepareLintProjects } from "@justmumu/justomp/lint";

// Explicit setup for all inspected projects; may install and change metadata.
const preparation = await prepareLintProjects(root, signal);

// Check only the selected project. No setup or automatic repair.
const result = await checkProjectLint(root, "python:pyproject.toml", signal);
```

The check API reports unprepared valid targets as incomplete results. Invalid or unknown IDs throw; the CLI and OMP adapter serialize those failures into error JSON.

The installed CLI is check-only:

```sh
justomp-lint --root /absolute/path/to/repository --project-id python:pyproject.toml
```

It writes one JSON result to stdout. Exit codes are `0` for both checks passing, `1` for a completed non-passing result (including no sources), and `2` for incomplete execution or an input/setup error. It does not install tools, flush config, save receipts or publish a packaging snapshot.

Local `.justomp` runtime files are not automatically supplied to another checkout or CI machine. Keep repository-local `.justomp/tools/`, runtime receipts and reports ignored; the extension does not edit `.gitignore`. Supply the shared policy and tracked native configs, then explicitly prepare the pinned tools before using check-only. Lint/format preparation does not change project dependency declarations or locks, but may reconcile managed native fields in manifests such as `pyproject.toml` or embedded Prettier settings in `package.json`. Native readiness is verified even when state is supplied. Complete CI/startup/hooks still need typecheck/test runtimes and dependency preparation.

The [pre-commit](precommit.md) and [pre-push](prepush.md) hooks call the same shared lint service. Pre-commit applies safe lint fixes; pre-push checks without fixing. This engine migration does not change hook ordering or install a CI workflow. Use [`project_typecheck`](typecheck.md) for native project typechecking and [project_test and project_integration_test](testing.md) for tests. The public check API and CLI remain read-only. Explicit formatting is available through [project_format](format.md).

## Native verification and reproduction

The current release-owned tool set is Ruff 0.17.3, Biome 2.6.5, golangci-lint 2.15.0 and bundled Prettier 3.9.10. These pins are not a claim that every supported platform has been executed.

The earlier project-local ownership matrix exercised uv 0.11.6, Ruff 0.17.2/0.17.3 and Biome 2.6.3 on macOS arm64 and Linux arm64, with npm, Yarn PnP and custom pnpm layouts. That evidence does not verify the new installed-package ownership boundary. The existing runtime/manager fixture inputs remain relevant to dependency, typecheck and testing services: npm 11.12.1, pnpm 10.20.0, Yarn Classic 1.22.22, Yarn PnP 4.12.0, Bun 1.4.2, Node 26.0.0 and Go 1.25.6. Accepted manager families and provisioning are listed in [dependency test setup](dependencies.md#reproducing-native-tests).

Ruff and Go acquisition accepts Darwin/Linux x64/arm64; platform mapping is not native execution proof. No Windows support or new Linux libc support is promised by this cutover. Installed-package, runtime-isolation and native execution results must be recorded from the corresponding verification runs rather than inferred from a supported target.

Installed JS/Python lint and source formatting were executed on macOS arm64 and Ubuntu 24.04 x64 (glibc 2.39, Bun 1.4.2). The Linux run used local Docker CPU emulation, not a hosted CI runner. Both used production-only extension dependencies and an empty `PATH`, without child tool dependencies; removing the native Biome package produced an actionable `missing-tool` result.

```sh
bun run check
bun run test:lint
# Includes existing inspection/dependency tests and installed-package smoke:
bun run check:integration
```

`test:lint` runs lint integration tests and the real OMP lint tests. Provision the managers required by fixtures and unchanged typecheck/testing consumers on `PATH`; they are not used to choose Ruff/Biome lint executables. `JUSTOMP_YARN_MODERN_BINARY` and `JUSTOMP_YARN_CLASSIC_BINARY` can select fixture launchers. `JUSTOMP_GOLANGCI_ARCHIVE` optionally points to an official 2.15.0 archive. Without it, the Go fixture downloads the exact official platform archive, verifies its checksum and caches it under the OS temporary directory. Missing prerequisites fail tests rather than skipping coverage.

The mixed-repository fixture combines root Python, `apps/web` TypeScript and `services/api` Go. Its behavior coverage includes independent source scope, readonly checks, project membership, partial preparation/retry and shared policy repair. These cases are not a lint performance benchmark. Inspection-only measurements in [inspection documentation](inspection.md#measured-local-results) do not measure native lint or typed analysis costs.

| Acceptance behavior                                          | Test locations                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Field defaults and empty replacements                        | `tests/unit/config/lint.test.ts`, `tests/integration/config.test.ts`                                            |
| New Python membership, empty folder ignored                  | `tests/integration/omp/lint.test.ts`, `tests/integration/lint/mixed-repository.test.ts`                         |
| Partial native effects and same-target retry                 | `tests/integration/lint/python.native.test.ts`, `tests/integration/lint/mixed-repository.test.ts`               |
| Selected scope, Biome diagnostics and native package layouts | `tests/integration/lint/javascript.native.test.ts`, `tests/integration/lint/javascript-outcomes.native.test.ts` |
| Format-only failure without source writes                    | `tests/integration/lint/python.native.test.ts`, `tests/integration/lint/go.test.ts`                             |
| Application TypeScript remains unchanged by lint preparation | `tests/integration/lint/javascript.native.test.ts`, `tests/unit/checks/javascript-preparation.test.ts`          |
| Shared resource ordering and process cancellation            | `tests/integration/lint/concurrency.test.ts`, `tests/integration/omp/lint.test.ts`                              |
| Independent readonly API/CLI                                 | `tests/integration/lint/cli.test.ts`, `tests/integration/omp/installed-smoke.native.test.ts`                    |
| Release-owned tools without project runtimes/dependencies    | `tests/integration/lint/owned-tools.native.test.ts`                                                             |
