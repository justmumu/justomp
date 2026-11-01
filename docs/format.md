# Project formatting

`project_format` formats and saves files owned by one inspected project. Start with `list_projects({})`, then pass the returned ID:

```json
{ "project_id": "python:apps/api/pyproject.toml" }
```

Omit `files` to format all supported files in that project. To select files, supply exact paths relative to that project's directory:

```json
{
  "project_id": "python:apps/api/pyproject.toml",
  "files": ["src/main.py", "pyproject.toml", "README.md"]
}
```

An empty list, directory, missing file, traversal, or unsupported selection fails before formatting starts. Repeated paths run once. Child projects, symlinks, special files, dependency directories, locks and Justomp's internal state are outside the format scope. Hidden project files such as `.github/workflows/check.yml` are supported. Moving a project changes its ID. As with the existing project tools, inspection must identify a supported native package manager; ambiguous or unsupported manager metadata is reported before formatting.

The OMP tool uses the `exec` approval tier. Its JSON text and `details` contain the same result. Formatting uses the existing trusted custom-tool boundary, including for supported protected manifests; general write/edit restrictions remain unchanged. Session startup does not format source files.

## Engines and preparation

| Files | Engine |
| --- | --- |
| Python project's `.py`, `.pyi` | Prepared Ruff `format` |
| Go project's `.go` | Prepared golangci-lint `fmt`, with gofumpt and goimports by default |
| JS/TS, JSON/JSONC, YAML, Markdown/MDX, HTML, CSS/SCSS/Less | Bundled Prettier |
| TOML, including `pyproject.toml` | Bundled Prettier TOML plugin |

Ruff lint fixes and ESLint fixes are not run. Go formatting includes the agreed import organization. `go.mod`, `go.work`, sums, lockfiles and notebooks are not format targets. Known JSONC configuration filenames, including `tsconfig*.json` and Pyright configs, keep their comments.

Prettier belongs to the extension, so formatting documents or TOML in a Python/Go project does not install Node packages into that project. Native preparation runs only when the selected files need Ruff or Go formatters. It reuses retained versions and existing preparation; a newly discovered Python or Go project aligns the relevant native formatter tools across that ecosystem. Formatting waits for the entire required group to reach its accepted target. Preparation can change shared manifests, locks, environments and projected settings beyond the selected files. The result reports those effects separately.

`project_lint` and `project_format` use the same formatter engine and effective settings for files they both cover. Lint keeps its existing source scope: formatting a document does not make it a lint requirement. Genuine lint errors can remain after formatting. JS lint no longer installs or verifies project-local Prettier; an existing user dependency is preserved.

## Shared configuration

Every field is optional. Startup and explicit preparation complete missing attributes in `.justomp/config.json`. A normal config read does not write it. Shared Prettier options live under `format.prettier`:

```json
{
  "format": {
    "include": ["**/*"],
    "prettier": {
      "printWidth": 120,
      "tabWidth": 2,
      "useTabs": false,
      "semi": true,
      "singleQuote": false,
      "trailingComma": "all",
      "endOfLine": "lf"
    }
  }
}
```

Default exclusions cover dependency, build, cache, coverage and generated output paths. `format.include` and `format.exclude` apply to project-relative paths and replace their default arrays, including when empty. They cannot override ownership, dependency, symlink or internal-state boundaries. Inspection rules independently decide which projects exist; format rules select files within those projects.

For compatibility, each Prettier option resolves from `format.prettier` first, then `lint.javascript.prettier`, then the source default. Flush writes the effective options to `format.prettier` and preserves the legacy subtree. Once written, the new value wins; change `format.prettier` for future formatting. Supported extra Prettier and TOML options are forwarded. Parser/plugin injection and automatic project config/editorconfig/plugin discovery are not supported.

Ruff settings remain in `lint.python.ruff`; Go formatter settings remain in `lint.go.golangci.formatters`. Python selection also honors Ruff's shared `exclude`, `extend-exclude`, and `format.exclude`. The shared defaults explicitly declare Ruff's established exclusion list, so retained Ruff versions use the same selection policy; `exclude: []` replaces that list. Bare exclusions match basenames at any depth, while slash-containing exclusions are relative to the selected project. Ruff's top-level exclusions also match ancestor directories; `format.exclude` matches files. Explicitly requested excluded files invalidate the whole selection before preparation or formatting writes.

Python source formatting currently requires exclusions directly in the shared Ruff policy. External Ruff `extend` configuration and exclusion glob syntax that cannot be matched faithfully fail with `unsupported-config`; they are never silently ignored. This does not block an explicit selection containing only common files such as `README.md` or `pyproject.toml`. Formatting managed configuration does not make its policy stale merely because quotes, spacing or line endings changed. Actual policy differences and missing ownership markers remain detectable.

Go source selection excludes dot basenames, uppercase `.GO` extensions and paths containing `...`, which the native CLI skips or rewrites. This version rejects nonempty `formatters.exclusions.paths` and generated modes other than `strict` or `disable` when Go sources are selected; it does not approximate native RE2 filters. Use `format.exclude` for shared file selection. Explicit common-file formatting still works with these native-only settings. Known generated Go outputs remain outside the format scope.

## Results, cancellation and concurrent changes

Results identify changed, unchanged, failed and not-run files, engine versions, preparation changes, affected projects and errors. Empty automatic scope and already-formatted files are successful. The tool stops at the first failure or cancellation, keeps prior writes and reports an incomplete result. A native formatter can change a file before failing; observed changes remain visible in the result. There is no rollback.

Formatting shares the dependency tools' mutation queues. It rechecks project ownership and configuration after waiting. Prettier output is published atomically after checking the original file identity and content; observed edits are not overwritten. Native formatters use explicit file arguments and are awaited before the queue is released. These checks do not provide OS-level isolation from arbitrary external editors during native execution.

Changed discovery metadata triggers an inspection refresh, including after partial failure. A failed refresh is reported without hiding completed writes. Existing typecheck/test fingerprints are revalidated naturally on later calls.

No formatter CLI, Git hook, CI configuration or automatic source-formatting lifecycle is installed by this feature.

Native formatting and the complete test gate were verified on macOS arm64 for this change. Linux uses the existing native tool paths but was not executed in this validation.
