# Repository releases

Justomp prepares one common version for the repository. It exposes three OMP tools and the same services through `justomp/release`. Release libraries are dependencies of Justomp, not of the projects it manages.

| Tool               | Input                      | Effect                                                                                        |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------- |
| `repo_changelog`   | `{}`                       | Refresh the generated Unreleased notes from commits                                           |
| `repo_bump`        | `{ "increment": "patch" }` | Prepare version, manifest, lock and changelog changes; `minor` and `major` are also supported |
| `repo_release_tag` | `{}`                       | Create a local annotated `vX.Y.Z` tag at the verified commit                                  |

All three tools use OMP's `exec` approval tier. They do not stage files, commit, push, open PRs or publish packages. Release operations do not flush config or prepare latest development tools.

## Prepare and tag a release

1. Commit the code changes. Bump requires a clean index, working tree and nonignored untracked file set.
2. Call `repo_bump` with an explicit increment. Inspect its diff and result.
3. Stage the reviewed files and commit through `repo_commit` or native Git. Follow the repository's PR and merge process.
4. Update the local default branch to the reviewed remote commit. Call `repo_release_tag` there.
5. Push the tag separately when publication is intended.

The tag tool reads the configured remote's live symbolic HEAD. Both the current branch name and commit must match it; a stale remote-tracking ref is insufficient. It checks committed versions and release notes, refuses existing local or remote tags and never replaces them. Git records its configured identity as the annotation's tagger; configure the repository with the desired GitHub noreply email before tagging. No identity is invented by Justomp.

Tag push, GitHub Release and npm publishing automation are separate follow-up work. OMP's GitHub PR/CI features can help with review, but are not a dependency of these release services.

## Common version and supported projects

The version record defaults to `VERSION`, containing a stable `X.Y.Z` followed by a newline. If it is absent, all static project versions must agree. With no static versions, the highest reachable stable repository tag supplies the baseline. If neither exists, choose an initial value in the version record and commit it first. Conflicting values are reported; Justomp never selects the largest project version to resolve a conflict.

Static JavaScript versions, including private packages, and uv-managed Python `[project].version` values move together. Versionless workspace containers do not receive invented version fields. Dynamic Python versions, Poetry-only metadata and unsupported managers are rejected before release writes. Go uses the repository version and tag; `go.mod`, toolchain directives and module dependency versions stay unchanged. This does not implement nested Go module publishing or `/v2` import-path migration.

Local dependency references change only when native workspace/lock evidence proves their target. Compatible constraints stay intact. Incompatible simple exact/caret/tilde JS constraints and supported Python `==`/`~=` constraints keep their form while moving to the target version. Source mappings remain local. Ambiguous ownership or an incompatible complex, alias, catalog or peer constraint requires manual resolution. External sources are not rewritten.

Native locks refresh once per owner, with install lifecycle scripts disabled and without upgrade flags. npm, pnpm and Bun use lock-only installation; modern Yarn uses update-lockfile mode. Yarn Classic may install dependencies because it has no equivalent lock-only mode. uv updates static versions with frozen metadata operations, then refreshes the shared lock. Native steps and their output are reported.

## Changelog ownership

Every Conventional Commit type is visible under a category, including custom types. Breaking notes and reverts are retained. Merge commit nodes are omitted while their constituent commits remain. Nonconventional messages appear in `skipped_commits` by OID.

History ends at a captured commit. Its baseline is the highest reachable canonical `vX.Y.Z` tag. Bring existing release tags and complete Git history into the checkout before running release tools: Justomp does not fetch and refuses shallow or incomplete history. With no release tag, optional `history_start` selects an inclusive ancestor; otherwise the full reachable history is used.

Justomp edits only its marked content. It preserves manual Unreleased prose and prior release sections. Bump consumes its generated Unreleased block and adds the target release section; it does not move human notes into the release. `manual_unreleased: true` reports notes left behind. Malformed or duplicate owned markers and existing target release sections are errors.

Standalone changelog generation may run with unrelated local changes. A later bump still requires a clean tree: commit the generated notes first or remove them yourself.

## Optional configuration

All attributes have defaults. Normal config completion writes only missing attributes and honors explicit values:

```json
{
  "release": {
    "version_file": "VERSION",
    "changelog_file": "CHANGELOG.md",
    "remote": "origin",
    "history_start": null
  }
}
```

Paths must be distinct repository-relative regular-file paths. They cannot target managed manifests, locks, Git metadata or the shared config. Symlinks and paths in nested repositories/submodules are rejected. The configured version record joins the generic write/edit/bash protected paths, even before creation; changelog prose stays editable. Trusted release services can update the version record.

## Results and recovery

Results include `success`, `status`, `changed_files`, `participants`, `affected_projects`, `native_steps` and `diagnostics`. Status is `success`, `rejected`, `failed`, `cancelled` or `partial_change`. Bump reports previous/target versions and history OIDs. Tag reports `created`, `observed_target` and `default_branch`; `created: null` means its actual existence could not be established.

`changed_files` includes Git-visible changes and planned release metadata, even when that metadata is ignored by Git. Dependency installation directories are represented by native steps rather than enumerated.

On failure or cancellation, inspect the reported files or tag before retrying. Native work can leave partial changes. Justomp performs uncancelled readback, does not reset/stash/roll back, and never describes incomplete work as success. Process-local leases coordinate its own dependency, commit and release calls; external editors and other processes are not locked out.

```ts
import { bumpRepository, updateRepositoryChangelog, tagRepository } from "justomp/release";

const result = await bumpRepository(root, { increment: "minor" }, signal);
// Inspect result and diff; commit/merge separately before tagRepository(root, {}, signal).
```
