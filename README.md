# justomp

An OMP extension for inspecting Python, JavaScript/TypeScript and Go projects and managing their dependencies with installed native package managers. It discovers projects, workspace membership and local sources below the session directory. Dependency operations can install packages and run native lifecycle scripts.

Developed against OMP **18.13.3** and Bun **1.4.2**. From this checkout:

```sh
bun install --frozen-lockfile
omp plugin install /absolute/path/to/justomp
```

Start a new OMP session in the project you want to inspect. Local installation links the checkout; restart OMP after changing extension code. See the [OMP plugin instructions](https://omp.sh/docs/plugins).

Start with `list_projects({})` to get project IDs, then `dependency_list({project_id})` to inspect declarations and supported groups. Use `dependency_add`, `dependency_remove`, `dependency_update` and `dependency_sync` for native changes. Each operation selects its manager from project metadata; the agent supplies no executable, command or working directory. See [dependency tools and tested capabilities](docs/dependencies.md) for request examples, approval behavior and native limits.

`project_inspect` remains available with optional `refresh: true`. It returns a summary and structured report without running project code or package managers. Session startup calls the same inspection service, fills missing configuration attributes, and publishes `.justomp/packaging_structure.json`. Snapshot schema version 2 uses `project_id` instead of `id` in projects and relationship references; this is a pre-release API change. The ID is stable while its manifest's relative location stays the same.

## Configuration

Do not create a config file just to enable the extension. At session startup, the extension creates `.justomp/config.json` when absent, using these defaults:

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

Every field is optional. Startup fills only absent fields. Existing arrays replace defaults, including empty arrays, and unknown fields are preserved. For example, an existing `exclude: []` remains empty; startup adds the missing `include` only. Invalid config is reported without rewriting it.

Patterns are root-relative paths with `/`, `*` and `**`. Exclusions win, including excluded ancestors. An empty `include` selects no projects. An empty `exclude` removes the default exclusions, so dependency and hidden directories may then be inspected. `.git` is not used to find or limit the project root.

Each tool/getter call rereads the small config file. Rule changes replace the watcher scope and trigger inspection; the getter never fills missing config fields on disk. That completion belongs to the next session startup.

## Freshness and writes

A healthy native watcher invalidates the in-memory report when relevant manifests or directories change. The next call refreshes it. Ordinary source-file edits do not trigger inspection. The disk JSON is the last successful publication, not a cache input or a guarantee that the filesystem has stopped changing.

`project_inspect` and `list_projects` declare OMP's `write` approval tier because they publish JSON. All five `dependency_*` tools declare `exec`, including inventory calls that can run native metadata commands. The session-start hook is trusted extension code: enabling the plugin permits its startup config/snapshot writes. OMP tool approval does not sandbox lifecycle hooks. Filesystem permission failures remain errors; the extension does not bypass them.

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

```sh
bun run check
bun run test:integration
# Focused native-manager and OMP suites (requires provisioned managers):
bun run test:dependencies
bun run bench:inspect
```

The integration suite uses temporary projects. Native dependency suites require the explicit [tested manager versions and provisioning](docs/dependencies.md#reproducing-native-tests); missing managers fail the suite instead of silently skipping it. Its installed-package smoke test packs and installs this package into a temporary directory with lifecycle scripts disabled; it may download missing npm dependencies. OMP integration tests use the real loader, runner and approval wrapper with isolated temporary auth storage, without a model request.

See [inspection details and measurements](docs/inspection.md) for the supported relationship rules and measured costs.
