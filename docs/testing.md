# Project tests

`project_test` runs one project's unit tests; `project_integration_test` runs its integration tests. Get its `project_id` from `list_projects({})` first.

```json
{ "project_id": "python:apps/api/pyproject.toml" }
```

Optional `test_files` contains exact paths relative to that project, not the repository root, globs or test names. Providing it selects only those files and disables the project-wide coverage threshold, even when the list happens to contain every test file.

```json
{ "project_id": "javascript:apps/web/package.json", "test_files": ["tests/unit/cart.test.ts"], "timeout_seconds": 120 }
```

`timeout_seconds` is a positive integer, defaults to 300, and is a tool input rather than configuration. One budget begins after runner preparation and covers collection, all test subprocesses and coverage imports. Cancellation or timeout stops and joins the supervised process tree before releasing shared manager access. Ordinary assertion failures do not stop the remaining selected tests; Justomp adds no automatic retry.

## Runners and setup

| Project     | Runner                        | Default test paths                     |
| ----------- | ----------------------------- | -------------------------------------- |
| Python      | pytest + pytest-cov           | `tests/unit/**/test_*.py`              |
| Node JS/TS  | Vitest + matching coverage-v8 | `tests/unit/**/*.test.{js,jsx,ts,tsx}` |
| Bun runtime | `bun test`                    | `tests/unit/**/*.test.{js,jsx,ts,tsx}` |
| Go          | `go test`                     | Colocated `**/*_test.go`               |

A Bun package manager alone does not identify a Bun runtime. Explicit test scripts and runtime metadata determine the runner. An active unsupported or ambiguous runner is reported before setup; Justomp does not migrate tests. Unit and integration include/exclude policies select separate file sets.

At first preparation, pytest/Vitest tools are installed as exact dev dependencies through the existing package-manager adapters. A newly discovered project starts a common latest-version alignment for projects using the same runner. Ordinary session starts verify existing tools without refreshing latest. An incomplete alignment resumes its persisted exact target for unchanged membership. A newly discovered project replaces that target with latest on the next serialized pass, even when the previous installation failed; compatibility failures never silently select an older version. New membership is accepted only after resolution succeeds. The full current runner group must be ready before tests execute; removing its last member clears its target. Existing compatible application Vite is preserved; incompatible Vite is reported. Bun and Go use the installed runtime and are not automatically upgraded. Go requires 1.22 or newer, as well as the project's own minimum version.

Session startup and later discovery may prepare tools and write manifests, locks and receipts. They never run tests. Setup changes and affected project IDs appear under `preparation`; those effects can include sibling workspaces. Tool denial does not disable the trusted session lifecycle. A caller can stop waiting for shared preparation while another session keeps it alive.

Lint/format ownership does not centralize test runners. Their project dependencies, latest-version policy and runtime requirements are unchanged: Python tests need Python/uv, Node tests need their Node/manager environment, Bun tests need Bun, and Go tests need Go and application dependencies. Full startup and pre-push still prepare test tools even though isolated lint/format does not require Python, uv or Node.

## Configuration and coverage

All fields under `test` in `.justomp/config.json` are optional. Startup/preparation fills missing attributes from [the defaults](test-defaults.json). Existing valid values, unknown keys, `false`, `0` and empty arrays are preserved. Arrays replace defaults. One policy per ecosystem applies to all its projects. Test files and application sources have separate include/exclude patterns, relative to each project.

Full runs enforce a default minimum of 70% across all owned sources, including sources never used by tests. Python/JS/TS use native line coverage; Go uses native statement coverage. Tests, fixtures, generated code, dependency directories and nested independent projects are excluded. User globs cannot cross those ownership boundaries. A zero executable total returns `not-applicable` with a null percentage; it does not invent 100%.

Bun full coverage uses a reusable dynamic importer in global teardown, after user setup and tests. It loads the exact owned source list with bounded concurrency, without adding Istanbul. Import-time code runs and contributes to coverage: a server or CLI entrypoint can have side effects or block, so exclude such sources explicitly when appropriate. Import failures identify the file and fail coverage; mocked or otherwise omitted files are not silently accepted. Targeted runs and disabled coverage do not force source imports.

Go retains the native `go test` default vet checks. Ambient `GOFLAGS` cannot disable them. Go file selection maps active native test files to runnable declarations with a packaged AST helper, then uses exact names within the normal package. `TestMain`, package initialization and private-function access remain intact. Full runs count identical internal/external test names separately; individual file attribution is omitted when native events cannot distinguish it. An internal/external name collision that cannot distinguish selected files returns `unsupported-test-selection`; helper-only selections do not run the whole package. Fuzz seeds can run as normal tests; benchmark and fuzz campaigns are not started. Supported build flags such as tags and race settings remain in effect; unsupported execution controls are reported.

Preparation writes durable policy into standard configs: native coverage sections for Python, the active Vitest/Vite config (default `vitest.config.ts`), and real `bunfig.toml`. Project setup, plugins and unrelated settings are preserved. A separate explicit integration config keeps its own suite policy. Unsupported dynamic configuration is reported rather than replaced by a wrapper.

Invocations pass exact files, coverage activation and report destinations through runner APIs/arguments. Python uses the public Coverage API; Vitest loads the project-local `vitest/node` API. Private request JSON files carry invocation data, not alternate native config. Native config bytes stay unchanged between full, targeted and integration runs.

Bun coverage stays off through the native default: preparation removes the `test.coverage` key because an explicit `false` overrides `--coverage` in the supported runtime. Full managed runs enable it with the CLI flag. Targeted and coverage-disabled runs omit that flag; no config is rewritten. Plain `bun test` does not imply Justomp's coverage gate.

Native setup/fixture/import configuration remains active where compatible. Justomp owns selection, report locations, retry/fail-fast and coverage controls. Unsupported native options produce errors instead of silently discarding their effect. It does not change explicit skip/todo/only declarations in test code.

## Results and API

Results contain `suite` (`unit` or `integration`), project identity, runner/version, full/targeted mode, requested/executed files, test counts and cases, coverage, preparation effects, elapsed execution time, errors and console truncation. Go totals count top-level tests once, with subtests in details. Unknown counts are null. No collected tests return `no-tests` and failure. A finished assertion failure can have `complete:true` and `success:false`; collection, timeout, missing/malformed report and cleanup errors are incomplete. Console truncation does not truncate the separate native report channel.

Each invocation creates a fresh private report directory and removes it after execution. Old reports cannot satisfy a new call. Changes to project sources, ownership or configuration during execution invalidate the result without an automatic rerun. Process-local queues coordinate Justomp calls in the same host, not arbitrary external editors or another process.

```ts
import { testProject, integrationTestProject } from "@justmumu/justomp/testing";
const result = await testProject(root, { project_id }, abortSignal);
const integration = await integrationTestProject(root, { project_id }, abortSignal);
```

The API validates identity and selection before preparation. OMP exposes the same flow at `exec` approval level. There is no new testing CLI, commit hook or CI configuration.

## Integration tests

Both tools accept the same `project_id`, optional exact `test_files` and optional `timeout_seconds`. The tool name selects the suite; there is no `suite` input. Default integration paths are `tests/integration/**/test_*.py` for Python, `tests/integration/**/*.test.{js,jsx,ts,tsx}` for JS/TS, and colocated `**/*_integration_test.go` for Go.

The optional `integration_test` section in `.justomp/config.json` has the same shape as `test`, with independent source patterns. Missing fields are flushed from [integration defaults](integration-test-defaults.json); existing arrays and values are preserved. Integration coverage starts with `enabled:false` and `minimum:0`. Enabling it measures all configured owned sources, but a low percentage alone fails only when the minimum is raised. Missing or malformed reports still fail. Targeted runs disable coverage. Full enabled Bun coverage has the same source-import side effects described above; disabled integration coverage does not import unused sources.

The two suites share installed tools, persisted version waves, execution ownership and cancellation. Calling the second tool or changing its policy does not start a latest-version upgrade. A newly discovered project still triggers the existing shared alignment rule. Startup never executes tests.

Justomp does not start services, containers, migrations or seed commands. Native fixtures and runner setup/teardown remain active. The project or external environment must provide required services. Native setup failures are reported like other execution errors. A hard cancellation cannot guarantee that user teardown or external-service cleanup finishes.

For JavaScript, `test:integration` is checked against the project's existing runner. Direct `vitest` or `bun test` commands are supported; unsupported runners, conflicting runtime choices, shell chains, dynamic selectors and wrappers return an error. A literal `--config`/`-c` path selects a config owned by this project. Literal config selectors (including quoted `--config="path with spaces.ts"`), Vitest's optional `run` word and positional test paths are accepted as evidence. Config selectors are the only supported flags: other flags, including `--preload`, `--environment` and `--env-file`, return `unsupported-config` instead of silently losing their effects. The script itself is never executed; Justomp's policy and tool input own file selection, reports and coverage. Put setup and runtime settings in compatible native runner configuration rather than script flags or a shell wrapper.

### Scope conflicts and Go tags

Both tools check the full effective unit and integration file sets before running. If a file matches both, `test-scope-conflict` names the files and policy keys to fix. Targeting one file does not bypass a project-wide conflict. Coverage sources exclude the union of both test sets. Changes to either policy or test membership during execution invalidate the result.

Go integration files must have a leading modern directive:

```go
//go:build integration

package app
```

Conjunctions such as `integration && linux` work. An expression such as `integration || linux` allows the file into a Linux unit build and is rejected. The native Go parser reads the expression; Justomp conservatively checks that positive `integration` is necessary. Complex equivalent expressions it cannot prove return `unsupported-integration-constraint`; rewrite them as `integration && (...)`. Missing, malformed, duplicate or misplaced directives return a file-specific error in both tools, including for files inactive on the current platform. Legacy `// +build` alone is insufficient. Justomp never rewrites these files.

Unit runs remove the `integration` build tag; integration runs add it. Other supported build flags remain effective. Native collection and execution receive the same tags. Only selected integration functions run, but normal Go package compilation can still compile unit test files. Package `init` and `TestMain` retain native behavior: tag integration-only helpers and initialization too. Justomp cannot infer service ownership from arbitrary code.

New Go unit defaults exclude `**/*_integration_test.go`. Previously flushed user arrays are not silently migrated. If an older config overlaps after adding an integration file, add this pattern to `test.go.exclude`, or adjust the two policies so their effective sets are disjoint.
