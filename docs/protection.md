# File protection

Justomp denies general file-tool writes to discovered project metadata. Trusted custom tools keep their metadata-writing behavior;
`project_format` can also format supported protected files. The protection installs automatically with the extension; no new config
fields, capability tokens or allow lists are needed.

Use `repo_commit({message})` for commits from OMP. It validates the message and
runs Git through a trusted custom tool so the pre-commit hook can format managed
files. A `git commit` launched by protected `bash` inherits that sandbox,
including its restrictions on hook subprocesses. Terminal and IDE commits use
the same installed hook. See [pre-commit behavior](precommit.md).

## Covered tools and targets

Native `write`, `edit` and `apply_patch` targets are checked before delegation.
The native edit parser supplies every target, including move destinations. A
mixed patch containing a protected target is rejected before any file changes.
Filesystem aliases and symlink destinations are checked. Archive/database writes
also check the containing file. Internal URL writes refuse with an instruction
to use a filesystem path because this adapter cannot resolve them safely.

The current inspection snapshot supplies root/nested manifests, workspace
manifests and shared lock ownership. Python protects `pyproject.toml` and `uv.lock`;
JavaScript protects `package.json`, detected manager locks (including configured
pnpm lock directories) and workspace metadata;
Go protects module/workspace metadata and checksum files. Justomp's shared config,
inspection/preparation state and generated lint/typecheck configs are protected.
Newly discovered projects enter the next call's target list. Incomplete inspection
or an unsafe path fails the call instead of returning an old allow decision.

`bash` is an extension-owned foreground runner. Each invocation gets a new policy
from the current inspection and starts `/bin/bash` inside the OS sandbox. Reads,
ordinary source writes and network access remain available. Command text is a
single shell argument, never evaluated by a host shell first. There is no native
OMP shell-snapshot or direnv preflight outside the sandbox.

```json
{"command":"git status --short","cwd":"apps/api","timeout":30}
```

`cwd` defaults to the session root and relative values resolve from it. Timeout
is in seconds (default 300; zero disables the deadline). Stdout and stderr stream
with a combined 128 KiB capture limit. Cancellation, timeout and shutdown terminate
the foreground process group. Ordinary surviving descendants in that group are
terminated before cleanup. Shell variables and functions do not persist between
calls. Native OMP async jobs, named services and PTY requests return an explicit
unsupported-mode error; they are not silently run without protection.

## Platforms

- **macOS:** requires the OS `/usr/bin/sandbox-exec`. The generated Seatbelt profile
  denies writes to protected paths and removal of their ancestor directories.
- **Linux:** requires `bwrap` (bubblewrap 0.8+) with `--disable-userns` and kernel
  permissions for user/mount/PID namespaces. Readonly target mounts and ancestor
  pins enforce the invocation's policy. Setup failure does not fall back to a
  normal shell. Existing protected targets that are symlinks or have hardlink
  aliases are refused rather than claimed safe.

Linux needs mount points for absent protected files. Preparation can create
empty placeholders and missing parent directories. Cleanup removes only the
unchanged placeholders owned by Justomp, after the invocation finishes; a
replacement or modified file is retained. Concurrent preparations share ownership
in memory. No baseline, rollback or persisted busy record is created. An abrupt
host kill can leave placeholders behind; inspect them before removing them.

Native boundary tests ran on macOS and on Linux aarch64 in a temporary Docker
container. Docker required `SYS_ADMIN`, unconfined seccomp and unmasked system
paths to permit nested bubblewrap; those are test-container requirements, not an
instruction to run OMP with those privileges on a normal Linux host. Real hosts
must enable their own namespace prerequisites.

## Accepted boundaries

**Eval is outside this protection.** Its Python/JavaScript code can still write
these files. This is a guard for the named general file tools and bash, not
isolation of the entire OMP host. Other extensions, external editors and terminals
are outside it. Existing custom tool implementations and their subprocesses remain
trusted. Automatic formatters/LSP behavior has not been redesigned or disabled.

**Linux concurrent atomic replacement is an accepted limitation.** If a trusted
custom tool or external writer replaces a protected file while a sandbox is
running, the running sandbox's readonly file mount can stop protecting that path.
The next bash invocation protects the current file again. There is no promise
that a running policy changes dynamically. Eval exclusion and this limitation
were explicitly accepted during implementation.

General file calls and foreground bash calls for one canonical root share a
process-local queue so their ordinary validation/write windows do not overlap.
Custom tools do not acquire this queue. This is not cross-process coordination;
separate OMP processes, excluded eval and deliberately escaped descendants are
not synchronized by it. The kernel policy still applies to sandbox descendants,
but this extension does not claim to contain a hostile OMP host or every IPC route.

## Verification

Pure tests cover our metadata selection, target extraction and policy argv.
Small native tests cover our process launch/deny handoff, cancellation and Linux
placeholder ownership. The OMP test covers native delegation, mixed-patch
rejection and the trusted-custom-tool distinction. These tests join the existing
`bun run check` and `bun run test:integration` gates; upstream language/tool rule
matrices are not duplicated.
