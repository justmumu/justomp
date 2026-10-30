# Project unit tests

`project_test` runs one project's unit tests. Get its `project_id` from `list_projects({})` first.

```json
{"project_id":"python:apps/api/pyproject.toml"}
```

Optional `test_files` contains exact paths relative to that project, not the repository root, globs or test names. Providing it selects only those files and disables the project-wide coverage threshold, even when the list happens to contain every test file.

```json
{"project_id":"javascript:apps/web/package.json","test_files":["tests/unit/cart.test.ts"],"timeout_seconds":120}
```

`timeout_seconds` is a positive integer, defaults to 300, and is a tool input rather than configuration. One budget begins after runner preparation and covers collection, all test subprocesses and coverage imports. Cancellation or timeout stops and joins the supervised process tree before releasing shared manager access. Ordinary assertion failures do not stop the remaining selected tests; Justomp adds no automatic retry.

## Runners and setup

| Project | Runner | Default test paths |
| --- | --- | --- |
| Python | pytest + pytest-cov | `tests/unit/**/test_*.py` |
| Node JS/TS | Vitest + matching coverage-v8 | `tests/unit/**/*.test.{js,jsx,ts,tsx}` |
| Bun runtime | `bun test` | `tests/unit/**/*.test.{js,jsx,ts,tsx}` |
| Go | `go test` | Colocated `**/*_test.go` |

A Bun package manager alone does not identify a Bun runtime. Explicit test scripts and runtime metadata determine the runner. An active unsupported or ambiguous runner is reported before setup; Justomp does not migrate tests. Integration test directories stay outside this tool's scope.

At first preparation, pytest/Vitest tools are installed as exact dev dependencies through the existing package-manager adapters. A newly discovered project starts a common latest-version alignment for projects using the same runner. Ordinary session starts verify existing tools without refreshing latest. An incomplete alignment resumes its persisted exact target; compatibility failures never silently select an older version. Existing compatible application Vite is preserved; incompatible Vite is reported. Bun and Go use the installed runtime and are not automatically upgraded. Go requires 1.22 or newer, as well as the project's own minimum version.

Session startup and later discovery may prepare tools and write manifests, locks and receipts. They never run tests. Setup changes and affected project IDs appear under `preparation`; those effects can include sibling workspaces. Tool denial does not disable the trusted session lifecycle. A caller can stop waiting for shared preparation while another session keeps it alive.

## Configuration and coverage

All fields under `test` in `.justomp/config.json` are optional. Startup/preparation fills missing attributes from [the defaults](test-defaults.json). Existing valid values, unknown keys, `false`, `0` and empty arrays are preserved. Arrays replace defaults. One policy per ecosystem applies to all its projects. Test files and application sources have separate include/exclude patterns, relative to each project.

Full runs enforce a default minimum of 70% across all owned sources, including sources never used by tests. Python/JS/TS use native line coverage; Go uses native statement coverage. Tests, fixtures, generated code, dependency directories and nested independent projects are excluded. User globs cannot cross those ownership boundaries. A zero executable total returns `not-applicable` with a null percentage; it does not invent 100%.

Bun full coverage uses a reusable dynamic importer in global teardown, after user setup and tests. It loads the exact owned source list with bounded concurrency, without adding Istanbul. Import-time code runs and contributes to coverage: a server or CLI entrypoint can have side effects or block, so exclude such sources explicitly when appropriate. Import failures identify the file and fail coverage; mocked or otherwise omitted files are not silently accepted. Targeted runs and disabled coverage do not force source imports.

Go retains the native `go test` default vet checks. Ambient `GOFLAGS` cannot disable them. Go file selection maps active native test files to runnable declarations with a packaged AST helper, then uses exact names within the normal package. `TestMain`, package initialization and private-function access remain intact. Full runs count identical internal/external test names separately; individual file attribution is omitted when native events cannot distinguish it. An internal/external name collision that cannot distinguish selected files returns `unsupported-test-selection`; helper-only selections do not run the whole package. Fuzz seeds can run as normal tests; benchmark and fuzz campaigns are not started. Supported build flags such as tags and race settings remain in effect; unsupported execution controls are reported.

Native setup/fixture/import configuration remains active where compatible. Justomp owns selection, report locations, retry/fail-fast and coverage controls. Unsupported native options produce errors instead of silently discarding their effect. It does not change explicit skip/todo/only declarations in test code.

## Results and API

Results contain project identity, runner/version, full/targeted mode, requested/executed files, test counts and cases, coverage, preparation effects, elapsed execution time, errors and console truncation. Go totals count top-level tests once, with subtests in details. Unknown counts are null. No collected tests return `no-tests` and failure. A finished assertion failure can have `complete:true` and `success:false`; collection, timeout, missing/malformed report and cleanup errors are incomplete. Console truncation does not truncate the separate native report channel.

Each invocation creates a fresh private report directory and removes it after execution. Old reports cannot satisfy a new call. Changes to project sources, ownership or configuration during execution invalidate the result without an automatic rerun. Process-local queues coordinate Justomp calls in the same host, not arbitrary external editors or another process.

```ts
import { testProject } from "justomp/testing";
const result = await testProject(root, { project_id }, abortSignal);
```

The API validates identity and selection before preparation. OMP exposes the same flow at `exec` approval level. There is no new testing CLI, commit hook or CI configuration.
