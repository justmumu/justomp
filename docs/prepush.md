# Repository pre-push

Justomp installs one repository-level `pre-push` hook during an OMP session start, alongside its pre-commit hook. After installation, terminal and IDE pushes run the hook without an active OMP session. The launcher uses the installed Bun executable and Justomp CLI.

The gate discovers all projects using the repository's inspection rules, then runs:

1. Dependency consistency checks for every native manager scope (`dependency_sync` with `check: true`). These may install dependencies, using the existing frozen/immutable/check behavior. A failed check stops the gate before tool preparation can repair a stale lock.
2. Existing lint, typecheck and unit-test tool preparation, once for the repository.
3. For each project: format check, lint without fixes, typecheck and the full unit suite with the configured coverage policy.

Format checks use the same owned files, formatter selection and include/exclude policy as `project_format`, including supported metadata and documentation files. They never apply formatting changes. Unit coverage defaults to enabled with a 70% minimum; `.justomp/config.json` overrides remain authoritative. Integration tests and documentation builds are not part of this hook.

A failed or incomplete stage stops the push and identifies the project and stage. The CLI prints JSON to stdout and a stage summary to stderr. Exit codes are 0 for success (including an explicit no-project result), 1 for completed check failures and 2 for incomplete checks or infrastructure errors. Cancellation propagates to native subprocesses.

## Working-tree scope

The gate checks every discovered project in the current working tree. It does not select projects from pushed refs or changed files, require a clean tree, compare HEAD with a pushed commit, or create a separate checkout. Uncommitted changes participate in checks; success is not a certificate for an isolated commit.

The gate does not fix lint, format, stage, stash, commit or roll back files. Lint/format preparation installs Justomp-owned release-pinned tools and reconciles managed native configuration without changing project dependency declarations or locks. Typecheck/test preparation and dependency consistency checks retain their existing package, lock and runtime requirements. Type generation, test reports and caches may also be written. Those effects are reported and remain in the working tree; the hook does not stage them or add a new post-check dirty-tree restriction.

The Bun launcher does not make this full gate independent of Python, uv, Node or project dependencies: typecheck/testing still need their existing environments. Go lint/format also requires compatible Go and application dependencies. Tool caches under `.justomp/tools/`, runtime receipts and reports should remain ignored.

## Existing hooks and repository boundaries

Installation is idempotent. Compatible executable shell hooks run first with Git's original arguments and stdin. Their failure prevents Justomp checks. Justomp does not interpret ref-update input. Original hook backups and ownership records are separate for pre-commit and pre-push. Modified, externally managed or path-sensitive hooks report a conflict instead of being overwritten.

Nested session directories and linked worktrees resolve to their Git working-tree root. Submodules are excluded; native workspaces that include a submodule cannot safely prepare it as part of the parent and fail explicitly.

## Standalone invocation and protection

`justomp-prepush` takes no arguments and can also be run inside a repository to execute the gate without pushing. It uses the existing domain services; no `repo_push` agent tool is registered.

Git launched through OMP's protected bash inherits that sandbox, and so does its hook. A required preparation write can therefore fail under that entry point. Terminal/IDE pushes use their normal environment. This feature does not grant the trusted `repo_commit` path permission to push or weaken file protection.

## Developing Justomp itself

In this checkout, `bun install --frozen-lockfile` followed by `bun run setup`
prepares the repository and installs these same hooks without starting OMP.
`bun run check` calls the same pre-push service. Setup reports conflicts and
partial installation; rerunning it uses the installer's existing idempotence.
The local launchers contain absolute executable and CLI paths and are not tracked.
Terminal commit messages are not validated by a new commit-msg hook; message
validation remains the existing OMP `repo_commit` behavior.
