# Dependency tools

The extension uses installed uv, npm, pnpm, Yarn Classic, modern Yarn, Bun and Go binaries. It reads project metadata to choose the manager and workspace owner. It does not install missing managers, switch managers, upgrade runtimes, download Python/Go toolchains or enable package scripts that the native manager's policy disables.

## Selecting a project

Call `list_projects` with `{}`. Its JSON result contains only these fields:

```json
{"projects":[{"project_id":"javascript:package.json","relative_path":"."},{"project_id":"python:apps/api/pyproject.toml","relative_path":"apps/api"}]}
```

An empty root returns `{"projects":[]}`. IDs combine the ecosystem and normalized root-relative manifest location. Renaming a package or copying the same tree preserves its ID; moving its manifest changes the ID. Two ecosystems in one directory have different IDs and the same `relative_path`. An old ID fails with `project-not-found`; it is never parsed into an operation path.

All dependency inputs require `project_id`. Unknown fields are rejected, including alternative manager, ecosystem, command and working-directory fields. The shared getter rechecks the target before executing. Local/workspace sources and owners must remain within the selected session root, including symlink resolution. Existing local declarations, inherited sources and native source overrides are checked before execution too.

## Requests

Inspect declarations before selecting a group or changing packages:

```json
{"project_id":"javascript:package.json","include_transitive":true}
```

`dependency_list` defaults to direct declarations. Each entry includes its name, native group, source, declared specifier and evidence. Resolution lists preserve multiple native resolutions; an installed version is shown only when measured. `complete` and `diagnostics` distinguish missing graph evidence from an empty graph. The result also contains manager/version, supported groups and operation capabilities. Source and group combinations can still have native limits described below.

`dependency_add` requires a group and a nonempty explicit package list:

```json
{"project_id":"python:apps/api/pyproject.toml","group":{"kind":"dev"},"packages":[{"name":"httpx","version":">=0.28,<1","source":{"kind":"registry"}}]}
```

Every addition specifies a source. Registry versions may be native constraints. Other source forms omit `version`:

```json
{"name":"example","source":{"kind":"git","url":"https://example.org/example.git","ref":"v1.0.0"}}
{"name":"example","source":{"kind":"path","path":"packages/example"}}
{"name":"example","source":{"kind":"workspace","target_project_id":"javascript:packages/example/package.json"}}
```

Paths are relative to the inspection root, not the selected project. A workspace target must be a verified member of the same native workspace. A missing local target never becomes a registry lookup. Go Git sources instead require `url` equal to the module path and `ref` a native revision query.

`dependency_remove` removes only the selected native group:

```json
{"project_id":"python:apps/api/pyproject.toml","group":{"kind":"dev"},"packages":[{"name":"httpx"}]}
```

Groups are `runtime`, `dev`, `optional`, `peer`, `named` and `extra`. `named` and `extra` require a `name`; other groups forbid it. Each adapter supports only its native subset. Go requires explicit `runtime`; `indirect` is graph evidence, not an install group.

`dependency_update` always requires explicit, nonempty `packages`. There is no `all` or wildcard update:

```json
{"project_id":"python:apps/api/pyproject.toml","packages":[{"name":"httpx"}],"mode":"within_constraints"}
{"project_id":"python:apps/api/pyproject.toml","packages":[{"name":"httpx"}],"mode":"latest"}
{"project_id":"python:apps/api/pyproject.toml","packages":[{"name":"httpx","version":"0.28.1","group":{"kind":"dev"}}]}
```

The default is `within_constraints`: the chosen resolution must satisfy the starting constraints, though a manager may rewrite its native lower-bound spelling. `latest` may rewrite the selected declaration's constraint. An exact `version` can downgrade and cannot be combined with any explicit `mode` in the same request. Without `mode`, a mixed request applies exact versions where supplied and within-constraints elsewhere. Optional per-package `group` disambiguates repeated declarations; unresolved duplicate markers or sources are rejected. Git/local sources are not converted into registry releases.

`dependency_sync` takes `project_id` and optional boolean `check`. Omitted or `false`, it materializes the native environment using the manager's default group selection without an intentional upgrade. Managers with real locks require an existing compatible lock. Sync does not install every optional group together.

```json
{"project_id":"python:apps/api/pyproject.toml","check":true}
```

`check:true` validates dependency consistency with the installed manager. It does not repair a stale lock, relock or upgrade after a failure. Installation is allowed where the native validation requires it:

| Manager | Check command | Effects |
| --- | --- | --- |
| uv | `uv lock --check` | Validates the owner lock from the selected project; does not sync its environment. |
| npm | `npm ci --dry-run --ignore-scripts --no-audit --no-fund` | Validates the owner lock without installation or lifecycle scripts. |
| pnpm | `pnpm install --frozen-lockfile` | May install using the selected project's native scope. |
| Yarn Classic | `yarn install --frozen-lockfile --non-interactive` | Retains the existing declaration preflight; may install at the owner. |
| Modern Yarn | `yarn install --immutable` | May install and regenerate PnP loaders at the owner; cache writes are allowed. |
| Bun | `bun install --frozen-lockfile --dry-run` | Requires an existing text or binary lock; does not install. |
| Go | `go mod tidy -diff` | Checks the selected module's tidy state without a preceding download that could repair sums. May fetch modules/cache data; never applies the diff. |

pnpm and Yarn retain native lifecycle-script behavior. Check is an `exec` operation, not a promise of a read-only filesystem or offline execution. Only `outcome: "success"` passes. Native failure/cancellation, changed dependency input metadata, or failed metadata observation cannot pass. Generated `.pnp.cjs` and `.pnp.loader.mjs` changes are reported as permitted install outputs. Failed commands and changed metadata remain visible; Justomp neither rolls them back nor retries with a repair command. Go sums are integrity metadata rather than a lock, and may legitimately be absent. These semantics are shared by the API and OMP tool; this feature does not install Git hooks.

Checks inspect current working-tree files, not Git's staged index. A future pre-commit hook must decide how to handle staged versus unstaged changes and accept only a successful result.

## Results and lifecycle

Every tool returns its structured JSON in model-readable text content as well as OMP details. Mutation results report `requested`, `manager`, `native_steps`, `metadata_changes`, `affected_projects` and `diagnostics`. Outcomes are `success`, `rejected`, `failed`, `cancelled` or `partial_change`; non-success outcomes set the tool's error flag. A completed mutation can retain `outcome: "success"` and add `structure_refresh_error` if the following inspection fails. Do not repeat a successful mutation solely because snapshot refresh failed.

The native manager owns manifest, lock/integrity metadata and environment changes. If a later command fails, earlier changes remain unless the manager itself rolls them back. There is no extension rollback. Reports fingerprint dependency metadata, not every file in `.venv`, caches or `node_modules`; they are observations, not atomic filesystem snapshots. Captured process output is bounded and credential-like values are redacted.

Calls sharing a native lock/workspace or canonical environment destination queue within the process. Independent domains can run concurrently. Cancellation terminates the native process tree before releasing its queue slot. Session shutdown and root changes cancel and join both active and queued calls. A queued caller's cancellation does not kill another caller's process. There is no cross-process disk lock, daemon, retry or resumable background job.

`list_projects` uses OMP's `write` approval tier for snapshot publication. All five dependency tools use `exec`; host denial prevents the tool body and native mutation from running. Native lifecycle/build scripts use the existing manager policy. Approval is not an OS sandbox, and a daemonized process that escapes the supervised process group is outside the runner's guarantee.

Lint preparation also uses these native managers under the same queue lease, installing exact dev-tool targets and projecting shared policy. It can run at session startup without a dependency-tool call. [Lint lifecycle and ownership](lint.md) describe those effects and the separate check-only API/CLI. Checks do not call the public dependency mutation service or install missing dependencies.

## Tested manager families and native limits

| Variant | Exact tested binary | Accepted family | Native groups |
| --- | --- | --- | --- |
| uv | 0.11.6 | >=0.11.0, <0.12.0 | runtime, dev, named, extra |
| npm | 11.12.1 | >=11.0.0, <12.0.0 | runtime, dev, optional, peer |
| pnpm | 10.20.0 | >=10.0.0, <11.0.0 | runtime, dev, optional, peer |
| Yarn Classic | 1.22.22 | >=1.22.0, <2.0.0 | runtime, dev, optional, peer |
| Modern Yarn | 4.12.0 | >=4.12.0, <5.0.0 | runtime, dev, optional, peer |
| Bun | 1.4.2 | >=1.4.0, <1.5.0 | runtime, dev, optional, peer |
| Go | 1.25.6 | >=1.25.0, <1.26.0 | runtime |

The exact binaries above have native fixture evidence on macOS arm64 and Linux arm64; accepted families are compatibility bounds, not a claim that every patch release was tested. The Linux full gate included all supported manager fixtures and process-runner cancellation/output tests in a container with ext4 fixtures and an init process. Linux x64 and Windows runner/manager behavior remain unverified. Modern Yarn starts at 4.12 because that release works with the tested Git 2.52 behavior. Machine-readable versions are recorded in `tests/fixtures/dependencies/manager-versions.json`.

Project-required manager versions are checked separately. uv numeric PEP 440 clauses and equality wildcards are supported; unknown forms return `unsupported-manager-requirement`. Missing binaries, mismatched requirements, unknown managers and conflicting selection evidence fail explicitly. Auto-download and auto-pin launcher behavior is disabled per call.

Native limitations remain visible rather than changing the request's meaning:

- uv preserves group/extra/marker/source provenance. Ambiguous marker/source occurrences are rejected. Local paths containing `#` can fail in uv's native parser; the native failure and any changes are reported.
- npm/pnpm preserve selected declaration groups. pnpm peer add/update is rejected because native peer additions also write dev declarations and updates cannot preserve peer-only ownership. pnpm workspace YAML and plain destination settings are checked for shared writes and root boundaries; redirected locks are used for inventory, sync and change reporting. Before execution, the installed pnpm reports its effective configuration; unmodeled destination or lock-mode differences are rejected rather than silently ignored. Quoted INI destination values, destination values containing whitespace/interpolation/escapes, INI sections for destination keys, per-project workspace locks and branch lockfiles are rejected explicitly. Unsupported scoped operations do not fall back to broader edits.
- Yarn removal rejects a name declared in multiple groups because the native remove command would remove more than the selected occurrence. Classic Yarn rejects nonruntime workspace add/update when it would save the declaration under runtime. Classic local/workspace selection uses native `file:` absolute selectors, so a later tree relocation may require refreshing those declarations.
- Modern Yarn within-constraints updates can re-resolve the selected package names across the shared lock, including sibling projects. Sibling manifest constraints remain intact; affected projects and observed resolution changes are reported.
- Bun's native dotted-name Git assignment and duplicate-group dotted-key deletion cannot preserve the selected field and are rejected. Other duplicate-group/source changes are accepted only when native operations preserve the unselected declaration.
- Go `go.sum` is checksum metadata, not a lock. Sync runs native module download and can report native-required `go.mod`/sum changes; it does not run automatic tidy or `go work sync`. A selected module uses its own graph. Go require versions are minimums, so exact updates verify the selected version after native resolution. Registry/revision additions reject an existing replacement or workspace member that would override the requested source; the tool preserves those native rules. Local sources use native replacement declarations; registry updates of replaced modules are rejected. A `/v2` module-path migration or toolchain upgrade is outside this tool.

## Reproducing native tests

Install checkout dependencies with `bun install --frozen-lockfile`. Provide the exact uv, npm, Bun and Go versions above on `PATH`. The harness fails when a required binary is absent; it does not silently skip native coverage. Tests use temporary projects, controlled local registry/module proxies and local Git/source fixtures rather than public `latest` responses.

The following provisions the three additional JS manager launchers into a disposable directory. This is explicit developer test setup, not extension runtime behavior:

```sh
test_managers="$(mktemp -d)"
npm install --prefix "$test_managers" --ignore-scripts --no-audit --no-fund \
  pnpm@10.20.0 yarn@1.22.22 @yarnpkg/cli-dist@4.12.0
export JUSTOMP_PNPM_BINARY="$test_managers/node_modules/pnpm/bin/pnpm.cjs"
export JUSTOMP_YARN_CLASSIC_BINARY="$test_managers/node_modules/yarn/bin/yarn.js"
export JUSTOMP_YARN_MODERN_BINARY="$test_managers/node_modules/@yarnpkg/cli-dist/bin/yarn.js"
bun run test:dependencies
rm -rf "$test_managers"
```

These environment overrides are test-harness inputs, not agent tool parameters. The product resolves the installed native manager from project metadata and `PATH`. The focused command covers the native suites and real OMP loader/approval/packaged smoke. The normal `bun run check` and `bun run test:integration` gates remain unchanged. Installed-package smoke creates a separate installation, may download missing package dependencies with scripts disabled, and performs a native local-package mutation outside the checkout.

## Shared API

`justomp/dependencies` exports `executeDependency`, `listProjects`, the shared `schemas`, request types and the installed `adapters` registry. Callers provide a canonical session root and cancellation signal, retain/release inspection through `justomp/packaging`, and keep the call alive until cancellation settles. For example:

```ts
import { adapters, executeDependency } from "justomp/dependencies";
const result = await executeDependency(root, "list", { project_id }, adapters, signal);
```
