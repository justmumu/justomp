# Project typechecking

`project_typecheck` prepares and checks one inspected Python, JavaScript/TypeScript or Go project with shared repository policy. Python uses Pyright, JavaScript/TypeScript uses the native TypeScript compiler, and Go compiles packages and tests without running them. The selected check includes first-party test sources. It does not fix source code.

## Selecting and checking a project

Call `list_projects({})`, then pass a returned ID to `project_typecheck`:

```json
{"project_id":"python:pyproject.toml"}
{"project_id":"javascript:apps/web/package.json"}
{"project_id":"go:services/api/go.mod"}
```

These are separate calls. The tool accepts only `project_id`; it rejects executable, command, manager, working-directory and rule inputs. Invalid or unknown IDs fail before that call starts native setup. Moving a manifest changes its ID.

OMP registers this tool at the `exec` approval tier. Its JSON result appears in both `content` and `details`. The full operation may install development packages, update native manifests and locks, generate managed configuration, run Next type generation, and emit required local dependency declarations. Native package-manager lifecycle scripts retain their normal policy. Enabling the extension also enables its trusted background preparation; denying one tool call does not disable the session lifecycle.

## Shared policy

The root `.justomp/config.json` contains one `typecheck.python`, `typecheck.javascript` and `typecheck.go` policy for every corresponding project. No project-specific policy override exists. The [typecheck default example](typecheck-defaults.json) is compared with runtime defaults by a unit test. The [inspection and lint defaults](lint-defaults.json) occupy the other sections of the same file.

Python defaults to Pyright strict mode, with errors for missing stubs, implicit overrides and unnecessary type-ignore comments. Source and test files receive the same policy. JavaScript/TypeScript defaults to `strict`, `allowJs`, `checkJs`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noImplicitOverride`, with `skipLibCheck: false`. Go defaults to an empty `build_tags` list and the installed toolchain's current platform.

Every field is optional. Startup and explicit preparation complete absent fields independently. Existing `false` values and empty lists remain intact. Python's `diagnostics` map replaces the default map as a whole, including `{}`. Unknown fields survive completion; invalid known values fail without being replaced by defaults. For example, this partial input adds Go's `integration` build tag and receives the other missing defaults:

```json
{
  "typecheck": {
    "go": { "build_tags": ["integration"] }
  }
}
```

The inspection getter and check-only API read effective defaults without writing them. A policy change must be prepared before a check can succeed. Native source, module, JSX, import-path and environment context remains relevant, but native strictness opt-outs do not override the shared policy.

`typecheck.javascript.exclude` accepts an array of project-relative glob patterns, including dot paths, and defaults to `[]`. For example, `[".private/**"]` omits unimported private archives from selected JS/TS source entries. Explicit arrays replace the default; `[]` restores the ordinary owned-source scope. Changing exclusions requires preparation and invalidates the corresponding readiness evidence.

Lint and typecheck exclusions are independent. They do not change test selection or coverage ownership, and cannot include dependency directories, generated state, symlinks or child projects excluded by ordinary ownership rules. They are source-entry filters, not filesystem or import-security boundaries: TypeScript may still analyze an excluded file imported by selected code. Diagnostics are not hidden after checking.

## Preparation and retained versions

After startup inspection, background tooling and policy preparation runs outside the inspection handler's deadline. Discovering a new manifest makes the project eligible; creating an empty directory does not. The getter itself never installs tools. Without a healthy watcher, the next explicit full typecheck discovers and prepares the current projects.

The first Python preparation resolves the latest stable, non-yanked Pyright release. The first JavaScript preparation resolves the latest stable TypeScript release. Each ecosystem uses one exact version across all its projects. A newly discovered project ID starts a new resolution wave for that ecosystem; moved manifests count as new IDs. Ordinary checks, restarts with the same project set and deletion-only changes retain the target without querying latest. A failed wave retains its resolved version when retrying the same membership. A newly discovered project supersedes an incomplete target on the next serialized pass; it does not wait for the old installation to succeed. Resolution failure does not adopt new membership, so retry still selects latest. A selected project cannot pass while its required ecosystem wave is incomplete.

Native managers install or upgrade project dev dependencies and update their manifests, locks and environments. Existing compiler declarations must be compatible registry dev declarations; conflicting groups, overrides or sources require explicit reconciliation. No system package, Node/Python/Go runtime manager, LSP server, test runner or Git hook is installed. Missing runtimes are errors.

Exact targets and readiness evidence persist in `.justomp/typecheck_state.json`. A receipt never replaces verification of native tools, source/configuration inputs or generated outputs. Preparation, checks, lint and dependency operations share process-local resource leases. There is no persisted `BUSY` lock or rollback of completed native changes. A cancelled tool wait may leave shared setup running for another session. Closing the last owning session cancels and joins native work before releasing resources.

Typecheck owns the application TypeScript target. Managed lint uses Biome independently of the TypeScript compiler API and never installs or restores a compiler to satisfy a lint plugin. Typecheck preparation can invalidate stale legacy lint receipts; lint preparation then verifies its own current Biome environment. Typecheck success and lint success remain separate results. See [lint preparation](lint.md#javascript-and-typescript-versions).

## Native checking and generated files

| Ecosystem                | Preparation and selected check                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python                   | uv installs the Pyright dev package. Preparation updates `pyrightconfig.json` when present, otherwise `[tool.pyright]` in `pyproject.toml`. Relative import paths, inheritance and execution environments are preserved. The verified checker runs through installed Node with the interpreter passed at invocation; machine-specific environment paths are not written into native config. |
| JavaScript/TypeScript    | Strict policy and full source/test scope live in the real `tsconfig`/`jsconfig` graph. Native checks pass `--noEmit`. When production scope conflicts with source/test checking, preparation creates a real build entry and updates its ordinary build consumers while preserving production output locations.                                                                              |
| Next                     | Preparation runs native `next typegen`, including custom `typescript.tsconfigPath` and `distDir`, and records generated outputs. Native config loading can execute project setup and requires its environment. Check-only does not generate missing output.                                                                                                                                 |
| Local JS/TS dependencies | Required declarations use native build entries and declaration-only compiler flags. A distinct types scope can receive a real `tsconfig.types.json` and `build:types` entry; normal application output remains separate. No temporary check/declaration config is generated. Source declaration and JSON-only packages need no unnecessary emit.                                            |
| Go                       | Installed Go compiles source and test packages with `go test -c -vet=off` into temporary binary paths. It does not execute package initialization or test bodies. Results report platform and build tags.                                                                                                                                                                                   |

Existing multi-context source/test graphs are retained. Where separation is necessary, `tsconfig.build.json` carries the prior production include/exclude and output settings; the check entry still includes tests excluded from production. Build scripts, native references and Next entrypoints are reconciled together. Dynamic consumers that cannot be safely rewritten produce a configuration conflict. Config-only migration retains verified installed versions and does not start a latest-version wave.

Python preparation removes local `venv` and `venvPath` selectors so they cannot override the selected uv interpreter passed on the command line. Inherited environment selectors require explicit removal from their base config; preparation reports the conflicting field and path. Relative import paths and execution environments remain intact. If an active inherited execution environment overrides diagnostic policy, preparation names the conflicting field and base config instead of accepting the override. Local environment diagnostic overrides are removed while their project context is retained.

The source scope excludes dependencies, build/cache directories, symlinks, justomp outputs and separately discovered child projects. A root Python project does not typecheck Python files belonging to a discovered nested Go or JS project. Compilers may read imported dependencies required to analyze the selected project. Required declaration preparation can report diagnostics originating in those dependency projects without making them additional selected checks.

Generated-type receipts verify source, config, required dependency and output content. Missing or stale required declarations and Next output produce `not-run` in check-only mode. Full preparation repairs them before checking. Required declarations are rebuilt with the native incremental shortcut disabled so removed outputs are repaired; this is not an incremental-latency guarantee.

Next versions without `typegen`, config that needs unavailable environment, or an incompatible native API mode fail explicitly. There is no `next build` fallback, framework upgrade or automatic config workaround. A failed generation retains actual changes and diagnostics.

Go checks disable module/toolchain downloads. Missing modules require `dependency_sync`. A temporary workspace preserves the original `go.mod`, `go.sum`, `go.work` and `go.work.sum` bytes while permitting native workspace handling. Temporary binaries and workspace copies are removed after native processes close; Go may still use its compiler cache. No Go version is downloaded.

Every check runs the compiler again. Source or required dependency changes during execution invalidate completion while retaining observed diagnostics and preparation effects. There is no replay of a cached successful check.

## API, CLI and CI

The public API works without OMP:

```ts
import { prepareProjectTypecheck, checkProjectTypecheck, typecheckProject } from "@justmumu/justomp/typecheck";

const projectId = "javascript:apps/web/package.json";

// Prepares tools and required types; does not run the selected project check.
const preparation = await prepareProjectTypecheck(root, projectId, signal);

// Readonly verification and native check; never installs or generates.
const result = await checkProjectTypecheck(root, projectId, signal);

// Prepare tools, policy and required types, then check the selected project.
const full = await typecheckProject(root, projectId, signal);
```

All three accept an optional `AbortSignal` as their third argument. They reject invalid/unknown IDs. A valid but unprepared check-only target returns an incomplete result with `not-run`, not an automatic installation.

The installed CLI defaults to the full operation:

```sh
justomp-typecheck --root /absolute/path/to/repository --project-id javascript:apps/web/package.json
justomp-typecheck --root /absolute/path/to/repository --project-id javascript:apps/web/package.json --check-only
```

It writes one JSON result to stdout. Exit code `0` means a passing selected check, `1` means completed but non-passing (including no sources), and `2` means incomplete execution or an input/setup error. `--check-only` does not install, flush defaults, generate types, save receipts or publish inspection snapshots. This differs from the lint CLI, which is always check-only.

CI must receive the shared policy and explicitly prepare its environment. Retain exact targets if CI must avoid a new latest-version resolution; a fresh full operation can change native metadata. State copied from another checkout still requires native verification. The extension does not edit `.gitignore`, install hooks or create a CI workflow.

## Result meaning

Results identify the selected `project_id`, `relative_path`, `ecosystem` and `policy_hash`. `preparation` carries selected tool versions, affected project IDs, actual changed paths, diagnostics and errors. Each check includes native exit code, duration, status and diagnostics. Diagnostic `project_id` identifies the origin project; `path` is repository-relative and `project_path` is relative to that origin where available.

Statuses are `passed`, `failed`, `not-run` and `no-sources`. No sources is complete but not successful. Cancellation, truncation, stale evidence or unfinished checking prevents `success: true`; consult `incomplete_stages` and `remediation`.

The standalone `prepareProjectTypecheck` result's `complete` describes readiness of the selected project, including required generated types. In a check result, `preparation.complete` describes the aggregate setup wave, while top-level `complete` describes the selected check. An unrelated ecosystem's setup failure can therefore coexist with top-level `success: true`. Its errors and effects remain visible. `partial_change` means incomplete aggregate preparation left reported changes; no rollback is implied.

## Verified native limits and reproduction

The native evidence below was collected on macOS arm64. It is not certification of other operating systems, framework versions or manager combinations.

| Area        | Verified behavior                                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python      | uv 0.11.6, Pyright 1.1.414, Python 3.13.13 and Node 26.0.0; strict source/test checks and uv environment selection                                                                                                                                                                                  |
| JS managers | npm 11.12.1, pnpm 10.20.0, Yarn Classic 1.22.22 and Bun 1.4.2 install and check with TypeScript 7.0.2                                                                                                                                                                                               |
| Yarn PnP    | Yarn 4.12.0 fails its built-in TypeScript 7 compatibility patch. Yarn 4.18.1 installs TypeScript 7.0.2, but native compiler resolution of real PnP package imports/configs fails. The same package/config fixture works with TypeScript 5.9.3. No compiler downgrade or linker switch is performed. |
| Next        | Next 16.4.3 with TypeScript 7.0.2 passes native typegen, custom paths and a clean local dependency chain. Next 15.4.8 lacks typegen and fails explicitly.                                                                                                                                           |
| Go          | Go 1.25.6; module/workspace metadata preservation, package/test compilation, tags/platform context and non-execution sentinels                                                                                                                                                                      |

```sh
bun run check
bun run test:typecheck
# All integration tests, including installed-package API/bin/docs smoke:
bun run check:integration
```

Provision native managers as described in [dependency test setup](dependencies.md#reproducing-native-tests). `JUSTOMP_TYPECHECK_YARN_MODERN_BINARY` selects the installed Yarn 4.18.1 launcher for typecheck tests; the existing lint fixtures use their own `JUSTOMP_YARN_MODERN_BINARY`. Registry fixtures provide deterministic version metadata while native managers install real packages and compilers perform the checks. Missing prerequisites fail tests instead of skipping them.

The mixed repository test starts with a successful TypeScript 5.9.3 typed-lint check, upgrades through typecheck, verifies stale lint rejection and reports the retained tool incompatibility. It also checks Python/JS/Go source separation, diagnostic origin IDs, readonly hashes, dependency inventory and continued Go checking after native Python setup fails. Unit tests compare the published defaults with runtime policy; installed smoke checks the exported API, CLI and documentation files.

No typecheck performance benchmark was run. The [inspection measurements](inspection.md#measured-local-results) exclude compiler execution, generation and typecheck source hashing.
