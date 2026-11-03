import { rcompare, valid } from "semver";
import { type ReleasePolicy } from "../config/release/model";
import { git, gitText } from "../precommit/git";
import { ReleaseError } from "./model";
export interface HistoryCommit {
  hash: string;
  message: string;
}
export interface ReleaseHistory {
  end: string;
  base: string | null;
  tag: string | null;
  commits: HistoryCommit[];
}
export function selectReleaseTag(tags: readonly string[]): string | null {
  return (
    tags
      .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag) && valid(tag.slice(1)) === tag.slice(1))
      .sort((a, b) => rcompare(a.slice(1), b.slice(1)))[0] ?? null
  );
}
export function parseHistoryRecords(text: string): HistoryCommit[] {
  if (!text.trim()) {
    return [];
  }
  const fields = text.split("\0");
  if (fields.pop()?.trim()) {
    throw new ReleaseError("incomplete-history", "Git history has an incomplete record");
  }
  if (fields.length % 2 !== 0) {
    throw new ReleaseError("incomplete-history", "Git history has an incomplete message");
  }
  const records: HistoryCommit[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const hash = fields[i]?.trim() ?? "";
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) {
      throw new ReleaseError("incomplete-history", "Git history has an invalid commit identity");
    }
    records.push({ hash, message: fields[i + 1] ?? "" });
  }
  return records;
}
export async function captureHistory(
  root: string,
  policy: ReleasePolicy,
  signal?: AbortSignal,
): Promise<ReleaseHistory> {
  if ((await gitText(root, ["rev-parse", "--is-shallow-repository"], signal)).trim() === "true") {
    throw new ReleaseError(
      "shallow-history",
      "Fetch complete Git history and existing release tags before generating release notes",
    );
  }
  const end = (await gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
  const tags = (
    await gitText(root, ["for-each-ref", `--merged=${end}`, "--format=%(refname:strip=2)", "refs/tags"], signal)
  )
    .trim()
    .split("\n");
  const tag = selectReleaseTag(tags);
  let base: string | null = null;
  const exclusions: string[] = [];
  if (tag) {
    base = (await gitText(root, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], signal)).trim();
    exclusions.push(`^${base}`);
  } else if (policy.history_start) {
    const start = (await gitText(root, ["rev-parse", "--verify", `${policy.history_start}^{commit}`], signal)).trim();
    const ancestor = await git(root, ["merge-base", "--is-ancestor", start, end], signal);
    if (ancestor.exit_code !== 0 || ancestor.cancelled || ancestor.truncated) {
      throw new ReleaseError("invalid-history-start", "release.history_start must be an ancestor of the captured HEAD");
    }
    const parents = (await gitText(root, ["rev-list", "--parents", "-n", "1", start], signal))
      .trim()
      .split(/\s+/)
      .slice(1);
    exclusions.push(...parents.map((parent) => `^${parent}`));
  }
  const text = await gitText(
    root,
    ["log", "--no-merges", "--reverse", "--topo-order", "--format=%H%x00%B%x00", end, ...exclusions, "--"],
    signal,
  );
  return { end, base, tag, commits: parseHistoryRecords(text) };
}
