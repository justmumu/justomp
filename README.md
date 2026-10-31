# justomp

An OMP extension for inspecting Python, JavaScript/TypeScript and Go projects, managing their dependencies with installed native package managers, checking lint and type policy, formatting files, and running project unit and integration tests. It discovers projects, workspace membership and local sources below the session directory. Dependency operations and lint, typecheck and test preparation can install packages and run native lifecycle scripts.

Developed against OMP **18.13.3** and Bun **1.4.2**. From this checkout:

```sh
bun install --frozen-lockfile
omp plugin install /absolute/path/to/justomp
```

Start a new OMP session in the project you want to inspect. Local installation links the checkout; restart OMP after changing extension code. See the [OMP plugin instructions](https://omp.sh/docs/plugins).

Start with `list_projects({})` to get project IDs, then `dependency_list({project_id})` to inspect declarations and supported groups. Use `dependency_add`, `dependency_remove`, `dependency_update` and `dependency_sync` for native changes. Each operation selects its manager from project metadata; the agent supplies no executable, command or working directory. See [dependency tools and tested capabilities](docs/dependencies.md) for request examples, approval behavior and native limits.

Use `project_lint({project_id})` for a selected project’s lint and format checks. Pass `fix: true` to apply Ruff safe fixes or standard ESLint autofix before checking; Go reports that autofix is unsupported and still checks. Formatting remains a separate `project_format` call. It can prepare native dev tools and shared configuration before checking. Python uses Ruff, JS/TS uses ESLint + Prettier, and Go uses golangci-lint with gofumpt/goimports. See [lint setup, API/CLI and tested limits](docs/lint.md).

Use `project_format({project_id})` to format and save a selected project’s files, or pass `files: ["src/main.py", "pyproject.toml"]` for exact project-relative selection. Python uses Ruff, Go uses gofumpt/goimports, and bundled Prettier handles JS/TS, TOML and common document/config formats. See [format selection, shared settings and partial results](docs/format.md).

Use `project_typecheck({project_id})` to prepare and check a selected project with native Pyright, TypeScript or Go. Full preparation includes required Next types and local declarations; Go compiles tests without running them. See [typecheck setup, API/CLI and verified limits](docs/typecheck.md).

Use `project_test({project_id})` for unit tests with pytest, Vitest, Bun or Go. Optional `test_files` selects exact project-relative files; full runs enforce coverage (default 70%). Use `project_integration_test({project_id})` for the separate integration scope, with coverage off by default. Both share runner preparation; services remain the test infrastructure’s responsibility. See [test setup, coverage and results](docs/testing.md).

`project_inspect` remains available with optional `refresh: true`. It returns a summary and structured report without running project code or package managers. Session startup calls the same inspection service, fills missing configuration attributes, and publishes `.justomp/packaging_structure.json`. It then starts background lint, typecheck and test tooling/policy preparation outside the inspection deadline; that preparation can install tools and update manifests, locks and native config. Snapshot schema version 2 uses `project_id` instead of `id` in projects and relationship references; this is a pre-release API change. The ID is stable while its manifest's relative location stays the same.

General `write`/`edit` calls deny changes to discovered manifests, locks and Justomp-managed configuration. `bash` runs foreground commands in a fresh OS sandbox; custom tools keep their existing write behavior. macOS uses `sandbox-exec`; Linux requires bubblewrap 0.8 or newer with usable user namespaces. Eval is outside this protection. See [file protection and its limits](docs/protection.md), including the accepted Linux concurrent-replacement limit and foreground-only bash behavior.

## Configuration

Do not create a config file just to enable the extension. At session startup, the extension creates `.justomp/config.json` when absent. The inspection portion of its defaults is:

```json
{
  "inspection_rules": {
    "include": ["**/*"],
    "exclude": [
      "**/.*",
      "**/node_modules",
      "**/venv",
      "**/bower_components",
      "**/__pycache__",
      "**/__pypackages__"
    ]
  }
}
```

The same file also contains `format`, `lint`, `typecheck`, `test` and `integration_test` policies for Python, JavaScript and Go. See the [inspection and lint defaults](docs/lint-defaults.json) and [typecheck defaults](docs/typecheck-defaults.json) and [test defaults](docs/test-defaults.json), alongside [format settings](docs/format.md#shared-configuration).

Every field is optional. Startup fills only absent fields. Existing arrays replace defaults, including empty arrays, and unknown fields are preserved. For example, an existing `exclude: []` remains empty; startup adds missing fields without changing that array. Lint rule maps and Pyright diagnostic maps also replace their defaults, including `{}`. Explicit `false` values remain unchanged. Invalid config is reported without rewriting it.

Patterns are root-relative paths with `/`, `*` and `**`. Exclusions win, including excluded ancestors. An empty `include` selects no projects. An empty `exclude` removes the default exclusions, so dependency and hidden directories may then be inspected. `.justomp` internals and generated lint configs remain excluded. `.git` is not used to find or limit the project root.

Each tool/getter call rereads the small config file. Rule changes replace the watcher scope and trigger inspection; the getter never fills missing config fields on disk. Startup or explicit lint/typecheck/test preparation completes missing fields; a getter or check-only call does not.

## Freshness and writes

A healthy native watcher invalidates the in-memory report when relevant manifests or directories change. The next getter refreshes it. Active lint, typecheck and test lifecycles refresh discovery and prepare newly discovered projects in the background. Ordinary source-file edits do not trigger inspection. The disk JSON is the last successful publication, not a cache input or a guarantee that the filesystem has stopped changing.

`project_inspect` and `list_projects` declare OMP's `write` approval tier because they publish JSON. All five `dependency_*` tools, `project_lint`, `project_format`, `project_typecheck`, `project_test` and `project_integration_test` declare `exec`, including inventory calls that can run native metadata commands. The session-start hook is trusted extension code: enabling the plugin permits config/snapshot writes and background native lint/typecheck/test preparation. Denying an individual tool does not disable this lifecycle. OMP tool approval does not sandbox lifecycle hooks. Filesystem permission failures remain errors; the extension does not bypass them.

Watcher failure or an unverified filesystem disables cache reuse and uses full inspection per call. There is no polling fallback or debounce-driven scan. Shutdown releases subscriptions; sessions using the same root share the watcher until the last session releases it. Set `refresh: true` for an explicit full inspection.

Keep the generated snapshot out of version control if desired. The extension does not edit your `.gitignore`. Existing-config completion detects observed concurrent edits before replacing the file; arbitrary external editors still have a small check/rename race. Atomic publication prevents partial JSON, not filesystem snapshot isolation.

## Shared API

Other extension tools should use the getter rather than reading the JSON file:

```ts
import {
  getPackagingStructure,
  retainPackagingStructure,
} from "justomp/packaging";

const release = await retainPackagingStructure(root);
try {
  const { structure } = await getPackagingStructure(root, { signal });
  // Select projects using the returned report.
} finally {
  await release();
}
```

A session can retain its root once and release it at shutdown. Failed or incomplete inspection does not return an old report as success. A single caller's cancellation does not cancel a refresh still needed by another caller.

## Development

Configuration definitions live under `src/config/`: `inspection/` owns discovery defaults, types and validation; `lint/` and `typecheck/` own their shared policy types and resolution, with `python/`, `javascript/` and `go/` holding each ecosystem's defaults. `format/` owns file selection defaults and shared Prettier options. `load.ts` reads and completes the single config file. Runtime inspection, lint and typecheck execution stay in `src/inspect/`, `src/lint/` and `src/typecheck/`; lint/typecheck projections live below their respective runtime directories.

```sh
bun run check
bun run test:integration
# Focused native-manager and OMP suites (requires provisioned managers):
bun run test:dependencies
bun run test:lint
bun run test:typecheck
bun run bench:inspect
```

The integration suite uses temporary projects. Native dependency suites require the explicit [tested manager versions and provisioning](docs/dependencies.md#reproducing-native-tests); missing managers fail the suite instead of silently skipping it. Its installed-package smoke test packs and installs this package into a temporary directory with lifecycle scripts disabled; it may download missing npm dependencies. OMP integration tests use the real runner and approval wrapper with isolated temporary auth storage, without a model request. Native and installed-package cases exercise the file loader; local ownership cases bind the real extension factory with injected tool adapters.

The installed `justomp-lint --root <directory> --project-id <id>` CLI and `checkProjectLint` API are check-only. They require prepared tools and do not install, repair or write project metadata. The `justomp-typecheck` CLI defaults to full preparation and checking; pass `--check-only` for the readonly mode. `prepareProjectTypecheck`, `checkProjectTypecheck` and `typecheckProject` are exported from `justomp/typecheck`. No Git hooks are installed; CI must receive the shared policy and explicitly prepare its environment.

See [inspection details and measurements](docs/inspection.md) for the supported relationship rules and measured costs.

### Test evidence and cost

`bun run test:cost` runs `check` and the complete integration tree once, then
writes logs, unit and integration JUnit timings, and a JSON report under `.private/test-cost/`.
The command fails for failed/skipped/incomplete tests or a warm total above
300 seconds. `--baseline <report.json>` also requires at least a 60% reduction
against a successful warm run in the same recorded environment. This is an
optimization acceptance target, not a claim about current performance or CI.
Use `--cold` for a separate run with fresh package-manager stores; it still
requires all tests to pass. It does not erase machine caches or reinstall the
host tools, so it is not a cold operating-system benchmark.

Provision the native fixture tools pinned in `tests/fixtures/dependencies/manager-versions.json`
and described in the lint/typecheck documentation first. The command inherits their environment
variables. Feature test aliases overlap; do not concatenate them to measure the
full gate. `.native.test.ts` files exercise installed managers/compilers; other
integration files exercise local filesystem, watcher, process or host boundaries.
Fixture timings are a subset of wall time, not additional time to sum into it.

Before adding expensive tests, follow the
[test evidence and cost rule](compound-packs/testing/test-evidence-and-cost.md).
It is activated as a repository CE pack, with an AGENTS.md reference for direct
work and review paths that do not load packs automatically.
