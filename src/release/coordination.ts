import { withDomains } from "../dependencies/queue";
import { gitText } from "../precommit/git";
import { ReleaseError } from "./model";
import { inspectReleaseRepository, type ReleaseRepository } from "./repository";
export function releaseDomains(repo: ReleaseRepository): string[] {
  return [
    ...new Set([
      `justomp:repo-commit:${repo.git.gitDirectory}`,
      `justomp:release:${repo.git.commonDirectory}`,
      ...[...repo.scopes.values()].flatMap((scope) => scope.domains),
    ]),
  ].sort();
}
export async function withReleaseRepository<T>(
  cwd: string,
  signal: AbortSignal,
  work: (repo: ReleaseRepository) => Promise<T>,
): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const observed = await inspectReleaseRepository(cwd, signal),
      domains = releaseDomains(observed);
    const result = await withDomains(domains, signal, async () => {
      const current = await inspectReleaseRepository(observed.git.root, signal);
      if (JSON.stringify(releaseDomains(current)) !== JSON.stringify(domains)) {
        return { retry: true as const };
      }
      return { retry: false as const, value: await work(current) };
    });
    if (!result.retry) {
      return result.value;
    }
  }
}
export async function assertClean(root: string, signal?: AbortSignal): Promise<void> {
  if (await gitText(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], signal)) {
    throw new ReleaseError(
      "dirty-tree",
      "Commit or discard index, working-tree and nonignored untracked changes before releasing",
    );
  }
}
export async function assertHead(root: string, head: string, signal?: AbortSignal): Promise<void> {
  if ((await gitText(root, ["rev-parse", "--verify", "HEAD"], signal)).trim() !== head) {
    throw new ReleaseError(
      "head-changed",
      "HEAD changed during release preparation; inspect the repository before retrying",
    );
  }
}
