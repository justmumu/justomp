# Repository commits

The first OMP session in a Git working tree installs one repository pre-commit
hook. Terminal and IDE commits use the same standalone `justomp-precommit` Bun
CLI; OMP does not need to be running. Nested projects share this hook.

The active Git index determines which projects are affected. Renames consider
both paths; shared locks select their consumers. Unclear shared inputs select
all current projects. Each selected project is checked in its entirety:

1. Prepare managed lint/typecheck tools and configuration. Include other projects
   whose durable metadata changed during shared version alignment.
2. Apply supported safe lint fixes, then format.
3. Run final lint/format checks, typecheck (including required generated types),
   and `dependency_sync(check: true)`.
4. Stage observed durable changes and run `git diff --cached --check`.

No unit or integration tests run in this hook. Native dependency validation may
install environment files; it must not repair inconsistent dependency metadata.
Go workspace members receive separate module checks.

## Staging and failures

Checks read the working tree. They do not create an isolated staged-tree copy.
When a fixer or formatter changes a file, the **whole file** is staged, including
any changes that were unstaged before the hook. Unrelated dirty files are not
added. Durable preparation changes are included; caches, receipts, dependency
directories and ignored untracked files are not force-added.

A completed check failure blocks the commit but retains and stages fully observed
fixes so the next attempt includes them. Cancellation, incomplete observation or
detected concurrent edits prevents new staging. Files already written are never
rolled back. Avoid editing/staging concurrently with a commit: the hook detects
observed drift but does not claim exclusive ownership of other processes.

CLI stdout contains a JSON result with stage details, changed/staged files and
errors. Exit 0 means success, 1 a completed check failure, and 2 an incomplete
operation or infrastructure error. Git may forward hook stdout to stderr.

## Existing hooks and installation

Justomp keeps a composable original shell hook beside its launcher as
`pre-commit.justomp-original`, with ownership metadata in
`pre-commit.justomp.json`. The executable original runs first with its original
arguments, stdin, working directory and environment; failure prevents Justomp
from starting. Other hook stages are unchanged. Repeated sessions are idempotent.

External `core.hooksPath`, symlinks, managed/path-sensitive scripts or modified
owned launchers produce an explicit conflict. Justomp does not replace those
hooks or change `core.hooksPath`. Integrate `justomp-precommit` into the existing
hook explicitly in that case. The installed launcher pins the absolute Bun and
CLI paths and disables runtime auto-install; reinstall after moving the package.

Git worktrees and the active `GIT_INDEX_FILE` are respected. Submodule paths are
excluded from invocation discovery and native source selection; this temporary
scope does not replace the normal OMP inspection snapshot or user config.
If a native workspace declaration includes a submodule, preparation stops before
running the manager: inspection exclusions cannot override native workspace
membership. Keep that submodule outside the parent manager's workspace patterns.

## Committing through OMP

Use `repo_commit({ message: "feat(api): add health endpoint" })` after selecting
files in Git's index. This tool does not initially stage files, accept arbitrary
Git arguments, amend, push, or bypass hooks. The native hook runs once.

Git and existing repository hooks run as trusted extension processes. This is
necessary for managed fixes to write protected configuration files. Generic
bash/write/edit protection remains unchanged; a bash-launched Git hook inherits
that bash sandbox and cannot perform those writes.

`repo_commit` validates its input with extension-owned commitlint dependencies.
No commitlint package is installed in child projects. Empty or invalid input is
rejected before installation or Git mutation. The optional `commit` section of
`.justomp/config.json` defaults to:

```json
{
  "commit": {
    "header_max_length": 72,
    "types": ["feat", "fix", "docs", "chore", "ci", "refactor", "test", "style", "build", "perf", "revert"],
    "ignore_prefixes": ["Merge ", "fixup! ", "squash! ", "amend! ", "Revert \""]
  }
}
```

Missing fields are filled individually on normal config flush; explicit arrays
replace defaults. Type and subject must be nonempty; the subject must not end in
a period. Scope, breaking `!`, body and footer are supported. There is no extra
subject-case or body/footer line-length policy. Commitlint's implicit ignores
are disabled in favor of the explicit prefix list above.

This is input validation, not a new commit-msg hook: existing repository hooks
may change the message. The result reports the actual committed message and hash.
On cancellation, inspect `committed` and `commit_hash` before retrying. A null
`committed` value means the result could not identify whether this call committed.

## Pre-push

The [repository pre-push hook](prepush.md) checks the current working tree without lint fixes, formatting or staging. It runs lock consistency, format checks, lint, typecheck and unit tests with coverage for all discovered projects. Git and its hook retain the sandbox of their caller; no trusted push tool is added.
