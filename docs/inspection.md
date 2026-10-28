# Project inspection

`project_inspect` and the session-start hook use the same `getPackagingStructure()` service. It examines the selected session directory and its descendants. The root can be a project, a container of projects, or both. A directory can contain manifests for several ecosystems. An empty directory is valid.

The root is canonicalized but never expanded to an ancestor Git repository. Git metadata, `.gitignore`, tracked-file lists and directory names do not decide whether a project exists. Symlinks are reported as boundaries and are not followed. Inspection reads manifests and declared metadata; it never imports application code, executes config scripts, installs dependencies or runs a package manager.

## Discovery and relationships

| Input | Interpretation |
| --- | --- |
| `package.json` | JavaScript/TypeScript package metadata, engines, declared manager, dependency declarations and framework hints |
| `pyproject.toml` | Python project metadata, uv workspace and sources, or a tooling-only file |
| `go.mod` | Module identity, Go version, requires and replacements through a tokenizing parser |
| `pnpm-workspace.yaml` | Native pnpm membership patterns and exclusions |
| `go.work` | Explicit workspace members and workspace-level replacements |
| Recognized lockfile names | Package-manager evidence from presence; lockfile contents are not a dependency graph input |

Workspace membership and local dependencies are separate collections. Two packages in the same workspace do not automatically depend on one another. Edges require an explicit declaration: JavaScript `workspace:`, `file:` or `link:` references; uv workspace/path sources and supported direct Python paths; or a Go require matched with a local replacement. An unused Go replacement does not create an edge. uv sources can be inherited from a virtual workspace root without a root Python package.

The initial workspace resolvers are uv, pnpm and Go. Other workspace declarations, conditional uv sources, catalog references, unsupported aliases and unsupported native patterns produce unresolved diagnostics. Native workspace patterns support literal paths, `*` and `**`; they retain their manager's rules rather than reusing inspection-filter semantics. In the pinned pnpm interpretation, omitted `packages` selects only the root package, and ordinary `*` patterns do not include hidden names. Inspection exclusions can still remove a declared member; that loss is reported instead of silently overriding the user's rules.

Duplicate names, conflicting manager evidence and targets outside the selected root are reported. Name similarity or a compatible version string alone never creates a local edge. Framework names are hints from declared dependencies, not verification that an application runs. A tooling-only `pyproject.toml` can declare a workspace without becoming a Python project.

## Optional configuration

All fields in `.justomp/config.json` are optional. Code defaults are:

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

The plugin creates this file during the first session start if it is absent. On later starts it fills only missing attributes. Existing arrays replace defaults completely; they are never merged with defaults. `exclude: []` remains empty and removes the default exclusions. `include: []` remains empty and selects no projects. If only `exclude` is present, startup writes only the missing `include` default. Unknown fields survive completion. A startup with no missing fields does not rewrite the file.

Invalid JSON, wrong field types and unsupported patterns fail without rewriting the config. `null` is a present invalid value, not a missing value. Startup validates the whole configuration before writing any defaults.

Each getter reads config contents before making a cache decision. Equal file size or preserved modification time does not hide an edit. Changed effective rules replace the watcher scope and require inspection. Removed fields use defaults in memory until the next session startup; the getter does not flush them. Deleting the file also uses defaults in memory, and the next startup recreates it.

Patterns use root-relative `/` paths, literals, `*` and `**`. Absolute paths, escaping `..`, negation and other glob syntax are rejected. Exclusions win over includes, including an excluded ancestor. Required ancestors of an include can be traversed. A matching directory rule applies to its subtree. `**/node_modules` matches the exact directory name at every depth, not `my_node_modules_notes`. Generic names such as `build`, `dist`, `vendor` and `env` are not excluded by default.

The scanner and watcher apply the same rules before descending or creating child subscriptions. Default dot exclusion covers `.git`, `.venv` and other hidden names without metadata exceptions. Removing that exclusion permits hidden projects. The service's own config, snapshot and temporary files remain excluded as discovery inputs to prevent a feedback loop; other explicitly included `.justomp` content is not automatically hidden.

## Cache, publication and failure

A process shares one watcher and refresh job per canonical root, including when OMP reloads extension modules separately. Session owners retain the root and release it on shutdown. A single caller's cancellation does not cancel a refresh that another caller still needs. When all callers cancel, or the last owning session shuts down, pending work is aborted and joined before cleanup completes.

The first request waits for watcher readiness, inspects the tree and publishes a snapshot. Relevant manifest, workspace, lockfile and directory events invalidate the process-local report. Events do not start inspection or write JSON: the next getter refreshes. Ordinary source-file changes are not discovery inputs. On macOS, access-time-only notifications from reading a manifest are ignored when its identity and change metadata remain the same.

A healthy, unchanged watcher allows a clean getter to reuse the immutable report. It rereads the small config file, but performs no tree traversal, manifest parsing or snapshot rewrite. `refresh: true` explicitly bypasses the cache. A process never loads the existing disk JSON as cache input, even after a restart.

Publication writes a unique temporary file in `.justomp`, closes it, then atomically replaces `packaging_structure.json`. Only complete inspections are published. Malformed manifests, unreadable required inputs, invalid config or publication errors fail the call; a previous successful file may remain, but is not returned as success. Partial findings can accompany an error. A changed revision during inspection or publication prevents the result from becoming clean and requires another scan within the request budget.

The getter has a 25-second budget. The OMP adapter uses a 24-second deadline within the host's normal handler budget. Persistent churn or insufficient time produces an error rather than an indefinitely pending scan. These budgets include inspection work; event delivery is still governed by the operating system.

Known watcher errors, coverage loss, unverified filesystems and an environment request for Chokidar polling disable cache reuse. Calls then perform full inspection and report the reason. The extension does not silently poll, raise OS limits or start a daemon. Local APFS and Linux tmpfs are exercised by the test workflow; network filesystems are not verified. The native backend's directory coverage count is not interchangeable with kernel watch records or file-descriptor counts.

The JSON is the last complete publication, not an atomic snapshot of the whole filesystem. Delayed or lost native notifications can make a cached report temporarily stale. Multiple processes can publish complete files in completion order; the disk file has no global newest-scan guarantee. Consumers must use their getter's returned structure, and future mutation tools must verify the target inputs relevant to their operation.

The config and snapshot paths reject known symlinks. Same-process config completion is serialized; concurrent file creation cannot overwrite an existing file. Updating an existing config performs an immediate content/inode recheck before replacement. Arbitrary external editors still have a check/rename race; this is not a universal cross-editor compare-and-swap or an OS security boundary.

Installing the extension enables its trusted startup hook, including config and snapshot writes. The custom tool separately declares OMP's `write` tier and respects the host's tool approval decision. Tool approvals do not sandbox lifecycle hook code. The extension does not modify source files or `.gitignore`; users choose whether to ignore the generated snapshot and commit their config.

## Report contract

Schema version 1 includes:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Stored report schema version |
| `scanId`, `startedAt`, `completedAt` | Identity and times of the actual scan; cache hits keep these values |
| `root` | Canonical inspection boundary |
| `projects` | Relative path plus ecosystem identity, manifest, evidence, metadata and detection status |
| `workspaces` | Declaration, resolver kind, member project IDs and resolution status |
| `localDependencies` | Source/target project IDs with explicit declaration evidence |
| `diagnostics`, `excluded` | Ambiguity, unresolved declarations and traversal boundaries |
| `complete`, `metrics` | Whether selected traversal completed, plus scan duration and I/O counters |

Projects and relationships are deterministically ordered. `complete: true` means the selected traversal completed; it does not claim support for every manifest capability. Unsupported expressions can therefore appear as diagnostics in a complete report.

The getter wraps the structure with `cacheHit`, `refreshed`, optional `fallbackReason`, `waitMs`, `publishMs` and watcher status. `waitMs` is the request's total wait through completion, not a measurement of only queue contention. The watcher status exposes observed directory coverage for diagnostics, not mutation permission.

## Performance measurement

Run the full matrix from this checkout:

```sh
bun run bench:inspect > /tmp/justomp-benchmark.json
```

The harness creates and removes its own temporary projects. Progress goes to stderr; stdout is a single JSON report. It does not use the source checkout as a fixture and does not create a production `.justomp/config.json`.

| Fixture | Projects | Included entries | Excluded dependency entries |
| --- | ---: | ---: | ---: |
| Small | 1 | 100 | 0 |
| Medium | 50 | 10,000 | 0 |
| Large | 500 | 100,000 | 0 |
| Excluded tree | 50 | 10,000 | 1,000,000 |

Entries are actual files and directories, not simulated multipliers. Projects are flat JavaScript packages with explicit local dependencies. Source files and excluded empty files use hardlinks with a separate seed per directory; logical entry count and content storage are reported separately. Fixture generation uses bounded batches of 32 filesystem operations. The inspector itself performs sequential bounded I/O. The generated `.justomp` directory can add one excluded parent entry after the initial scan.

Each fixture measures one initial watch-and-inspect operation, 20 clean getters, 20 dirty refreshes and 20 full-inspection fallback calls. Dirty samples wait for an actual delivered watcher revision before calling the getter; event wait is reported separately. The fallback comparison deliberately sets `CHOKIDAR_USEPOLLING=true` inside the benchmark process: the adapter refuses polling and performs full inspection without subscriptions. The environment is restored afterward.

For each mode the report records sample count and p50/p95/max wall time, request wait, parse, relationship, publication and event-wait times. It includes directory/manifest counters, manifest bytes, observed concurrent inspector I/O and Chokidar directory coverage. Cache hits report zero new scan work instead of reusing the old report's scan counters as if they ran again.

Memory evidence is RSS sampled every 20 ms and at completed calls, together with process-lifetime max RSS. Sampling can miss shorter peaks; lifetime max RSS includes fixture construction. The report also includes a 350 ms watched-idle CPU sample, runtime/OS/CPU/memory/filesystem information, available active-resource types and observed process file descriptors before watching, after refreshes and after closure. File-descriptor observations include the temporary descriptor used to list them. OS block-I/O counters are not byte counts or syscall traces.

The initial operation is not labelled cold-cache: the harness does not flush OS caches. Local results do not establish network-disk performance. Wall-clock values are characterization data, not CI thresholds. Reproduce measurements on the same fixture and runtime before attributing a change to an optimization.

For a quick harness check, use `bun run bench:inspect --smoke`. It uses one 100-entry project plus at most 200 excluded entries, with the same 20 samples per repeated mode. `--excluded-entries N` changes only the excluded-tree workload for an explicit experiment; the default full matrix remains one million.

Deterministic integration tests verify that growing root and nested `node_modules`, `venv` and `.venv` trees adds no internal traversal or subscriptions; source contents are not read; clean getters do not rescan; and newly created nested projects are discovered after notification. Cancellation and shutdown tests cover pending publication and watcher release. Timing assertions do not replace those checks.

The expected trade-off is visible in the measurements: initial setup includes watcher discovery; unchanged requests reuse a report; a dirty request still performs a full scan. Frequent structural changes therefore reduce the cache benefit. Exclusions reduce both scan work and subscription growth without hiding in-scope new projects.

## Measured local results

Measured on 2026-10-28 with Bun 1.4.2, OMP 18.13.3, an Apple M2 Max (12 logical CPUs, 32 GiB RAM), macOS kernel 25.5.0 and APFS (filesystem type 26). The Node version reported by Bun is its compatibility version, not a separate Node process. OS caches were not flushed. Fixture construction and cleanup are excluded from request timings.

All values below are milliseconds. Initial setup has one sample; other modes have 20 samples. Repeated timings are p50 / p95 / max.

| Projects / included entries / excluded entries | Initial | Clean getter | Dirty refresh | Full-scan fallback | Watched directories |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 / 100 / 0 | 15.29 | 0.31 / 0.90 / 1.80 | 3.73 / 6.17 / 7.70 | 1.22 / 1.75 / 1.95 | 2 |
| 50 / 10,000 / 0 | 144.50 | 0.32 / 1.31 / 1.77 | 52.65 / 58.50 / 71.30 | 51.63 / 52.85 / 67.69 | 51 |
| 500 / 100,000 / 0 | 1984.49 | 0.75 / 2.51 / 2.71 | 516.48 / 559.90 / 629.56 | 519.01 / 543.72 / 614.12 | 501 |
| 50 / 10,000 / 1,000,000 | 158.35 | 0.37 / 1.18 / 3.26 | 52.92 / 54.64 / 70.99 | 50.44 / 53.32 / 53.74 | 51 |

All 80 clean getters reused the existing scan, with no manifest reads or snapshot publication. The one-million-entry excluded tree added only its `node_modules` parent entry to traversal: 10,001 observed entries, 51 inspected directories and 51 watched directories. Its 977 excluded directories received no child subscriptions. This compares with 10,000 entries and the same 51 directories without that dependency tree.

Sampled process RSS peaks were 69.9, 117.5, 254.4 and 127.2 MiB respectively. These are process observations, not per-project allocation limits; fixture construction and prior runtime activity affect the baseline. The short post-startup watched-idle CPU samples ranged from 0.86% to 5.64% of one core and include settling notifications; they are not sustained-idle estimates. File-descriptor observations were 5 before, during and after each fixture on this runtime and do not measure kernel watch registrations. Inspector I/O remained sequential.

The large fixture shows the trade-off: unchanged getters avoid roughly half a second of full-scan work here, while an actual structural change still pays that scan cost. The million-entry dependency tree did not scale scan work or watcher coverage. These local measurements are not latency guarantees for different hardware, directory distributions or network storage. The tool also serializes the report into model-visible content; these getter timings do not measure model response latency.
