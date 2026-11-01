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

The gate does not fix lint, format, stage, stash, commit or roll back files. Existing preparation may install/update managed tools, project configuration and lock metadata. Type generation, test reports and caches may also be written. Those effects are reported and remain in the working tree; the hook does not stage them or add a new post-check dirty-tree restriction.

## Existing hooks and repository boundaries

Installation is idempotent. Compatible executable shell hooks run first with Git's original arguments and stdin. Their failure prevents Justomp checks. Justomp does not interpret ref-update input. Original hook backups and ownership records are separate for pre-commit and pre-push. Modified, externally managed or path-sensitive hooks report a conflict instead of being overwritten.

Nested session directories and linked worktrees resolve to their Git working-tree root. Submodules are excluded; native workspaces that include a submodule cannot safely prepare it as part of the parent and fail explicitly.

## Standalone invocation and protection

`justomp-prepush` takes no arguments and can also be run inside a repository to execute the gate without pushing. It uses the existing domain services; no `repo_push` agent tool is registered.

Git launched through OMP's protected bash inherits that sandbox, and so does its hook. A required preparation write can therefore fail under that entry point. Terminal/IDE pushes use their normal environment. This feature does not grant the trusted `repo_commit` path permission to push or weaken file protection.
