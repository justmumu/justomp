import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { withDomains } from "../dependencies/queue";
import { git, gitContext, gitText } from "../precommit/git";
import { installPrecommit } from "../precommit/install";
import { validateMessage } from "./message";
import type { CommitResult } from "./model";
import { classifyCommit } from "./outcome";

export async function commitRepository(
  cwd: string,
  message: string,
  signal = new AbortController().signal,
): Promise<CommitResult> {
  const result: CommitResult = {
    success: false,
    committed: false,
    commit_hash: null,
    message: null,
    cancelled: false,
    errors: [],
  };
  try {
    const context = await gitContext(cwd, signal);
    if (!context) throw new Error("repo_commit requires a Git working tree");
    const policy = (await loadConfig(context.root, { signal })).commit;
    result.validation = await validateMessage(message, policy);
    if (!result.validation.valid) return result;
    return await withDomains(
      [`justomp:repo-commit:${context.gitDirectory}`],
      signal,
      async () => {
        const installation = await installPrecommit(context.root, signal);
        if (
          installation.status !== "installed" &&
          installation.status !== "ready"
        )
          throw new Error(installation.message);
        const before = await git(
          context.root,
          ["rev-parse", "--verify", "HEAD"],
          signal,
        );
        const temporary = await mkdtemp(join(tmpdir(), "justomp-commit-"));
        try {
          const path = join(temporary, "message");
          await writeFile(path, message, { mode: 0o600 });
          signal.throwIfAborted();
          result.committed = null;
          // Trusted, narrow entry: no shell, no initial staging, no arbitrary Git flags.
          result.native = await git(
            context.root,
            ["-c", "core.abbrev=no", "commit", "-F", path],
            signal,
          );
          // Cleanup/readback must outlive cancellation: Git may already have committed.
          const after = await git(context.root, [
            "rev-parse",
            "--verify",
            "HEAD",
          ]);
          const hash = after.exit_code === 0 ? after.stdout.trim() : null;
          result.committed = classifyCommit(
            before.exit_code === 0 ? before.stdout.trim() : null,
            hash,
            result.native,
          );
          if (result.committed && hash) {
            result.commit_hash = hash;
            result.message = (
              await gitText(context.root, ["show", "-s", "--format=%B", hash])
            ).replace(/\n$/, "");
            result.success =
              result.native.exit_code === 0 &&
              !result.native.cancelled &&
              !result.native.truncated;
          } else if (result.committed === null)
            result.errors.push(
              "This commit could not be identified with certainty; inspect Git history before retrying",
            );
          result.repository_status = await gitText(context.root, [
            "status",
            "--porcelain=v1",
            "-z",
          ]);
          result.cancelled = signal.aborted || result.native.cancelled;
          return result;
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
    );
  } catch (error) {
    result.cancelled = signal.aborted;
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
}
