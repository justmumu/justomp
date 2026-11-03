import { gt } from "semver";
import { parse as parseToml } from "smol-toml";
import { git, gitText } from "../precommit/git";
import { validateReleaseSection } from "./changelog";
import { assertClean, assertHead, withReleaseRepository } from "./coordination";
import { emptyReleaseResult, failRelease, releaseResponse } from "./effects";
import { selectReleaseTag } from "./history";
import { ReleaseError, type ReleaseResult } from "./model";
import { classifyParticipant, releaseObject } from "./participants";
import { type ReleaseRepository } from "./repository";
import { releaseSchemas } from "./schemas";
import { resolveCommonVersion } from "./version";

interface RemoteReleaseState {
  branch: string;
  head: string;
  tag: string | null;
}
interface TagObservation {
  exists: boolean;
  target: string | null;
  annotated: boolean;
}
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function parseReleaseRemote(text: string, tag: string): RemoteReleaseState {
  const rows = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const defaults = rows.filter((row) => row[1] === "HEAD" && row[0]?.startsWith("ref: refs/heads/"));
  const heads = rows.filter((row) => row[1] === "HEAD" && oid.test(row[0] ?? ""));
  if (defaults.length !== 1 || heads.length !== 1) {
    throw new ReleaseError("remote-default-unavailable", "Remote must expose one symbolic default HEAD and its commit");
  }
  const refs = rows.filter((row) => row[1] === `refs/tags/${tag}` || row[1] === `refs/tags/${tag}^{}`);
  if (refs.some((row) => !oid.test(row[0] ?? ""))) {
    throw new ReleaseError("incomplete-remote", "Remote tag response is incomplete");
  }
  const target = refs.find((row) => row[1]?.endsWith("^{}"))?.[0] ?? refs[0]?.[0] ?? null;
  return { branch: (defaults[0]?.[0] ?? "").slice("ref: refs/heads/".length), head: heads[0]?.[0] ?? "", tag: target };
}
export function assertReleaseRemote(remote: RemoteReleaseState, branch: string | null, head: string): void {
  if (remote.tag !== null) {
    throw new ReleaseError("tag-already-exists", "Target release tag already exists on the remote");
  }
  if (!branch) {
    throw new ReleaseError("detached-head", "Switch to the current remote default branch before tagging");
  }
  if (branch !== remote.branch) {
    throw new ReleaseError("wrong-branch", `Release tag requires default branch ${remote.branch}`);
  }
  if (head !== remote.head) {
    throw new ReleaseError(
      "remote-head-mismatch",
      "Local HEAD must equal the live remote default HEAD; update or publish the reviewed branch first",
    );
  }
}
export function classifyTagReadback(
  observed: TagObservation | null,
  head: string,
): { created: boolean | null; observed_target: string | null; verified: boolean } {
  return {
    created: observed?.exists ?? null,
    observed_target: observed?.target ?? null,
    verified: observed?.exists === true && observed.annotated && observed.target === head,
  };
}
async function currentBranch(root: string, signal?: AbortSignal): Promise<string | null> {
  const result = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  if (result.cancelled || result.truncated) {
    throw new ReleaseError("branch-unavailable", "Could not completely read the current branch");
  }
  if (result.exit_code === 1) {
    return null;
  }
  if (result.exit_code !== 0) {
    throw new ReleaseError("branch-unavailable", result.stderr || "Cannot read current branch");
  }
  return result.stdout.trim();
}
async function observeTag(root: string, tag: string, signal?: AbortSignal): Promise<TagObservation> {
  const ref = await git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], signal);
  if (ref.cancelled || ref.truncated) {
    throw new ReleaseError("tag-state-unknown", "Could not completely read the local release tag");
  }
  if (ref.exit_code === 1) {
    return { exists: false, target: null, annotated: false };
  }
  if (ref.exit_code !== 0 || !oid.test(ref.stdout.trim())) {
    throw new ReleaseError("tag-state-unknown", ref.stderr || "Could not read local tag reference");
  }
  const object = ref.stdout.trim();
  const type = (await gitText(root, ["cat-file", "-t", object], signal)).trim();
  const target = await git(root, ["rev-parse", "--verify", "--quiet", `${object}^{commit}`], signal);
  if (target.cancelled || target.truncated) {
    throw new ReleaseError("tag-state-unknown", "Could not completely read local tag target");
  }
  return {
    exists: true,
    target: target.exit_code === 0 && oid.test(target.stdout.trim()) ? target.stdout.trim() : null,
    annotated: type === "tag",
  };
}
async function committedRelease(repo: ReleaseRepository, head: string, signal: AbortSignal): Promise<string> {
  const policy = repo.config.release;
  if (repo.version.text === null) {
    throw new ReleaseError("version-required", `Commit ${policy.version_file} before creating a release tag`);
  }
  const version = await gitText(repo.git.root, ["show", `${head}:${policy.version_file}`], signal);
  if (version !== repo.version.text) {
    throw new ReleaseError("version-conflict", "The version record differs from the captured commit");
  }
  const participants = [];
  for (const manifest of repo.manifests) {
    if (manifest.project.ecosystem === "go") {
      participants.push(manifest.participant);
      continue;
    }
    const text = await gitText(repo.git.root, ["show", `${head}:${manifest.project.manifest}`], signal);
    const data =
      manifest.project.ecosystem === "javascript" ? releaseObject(JSON.parse(text)) : releaseObject(parseToml(text));
    participants.push(classifyParticipant(manifest.project, data));
  }
  const common = resolveCommonVersion(participants, version, null, policy.version_file);
  const changelog = await gitText(repo.git.root, ["show", `${head}:${policy.changelog_file}`], signal);
  validateReleaseSection(changelog, common);
  return common;
}
async function assertNewerVersion(root: string, head: string, version: string, signal: AbortSignal): Promise<void> {
  const previous = selectReleaseTag(
    (await gitText(root, ["for-each-ref", `--merged=${head}`, "--format=%(refname:strip=2)", "refs/tags"], signal))
      .trim()
      .split("\n"),
  );
  if (previous && !gt(version, previous.slice(1))) {
    throw new ReleaseError("version-not-newer", `Release version ${version} must be newer than ${previous}`);
  }
}
async function createAndReadTag(
  root: string,
  tag: string,
  head: string,
  result: ReleaseResult,
  signal: AbortSignal,
): Promise<void> {
  const args = ["tag", "--annotate", tag, "--message", `Release ${tag}`, head];
  result.created = null;
  let native: Awaited<ReturnType<typeof git>> | undefined;
  let nativeError: unknown;
  try {
    native = await git(root, args, signal);
    result.native_steps.push({ owner: ".", executable: "git", args, result: native });
  } catch (error) {
    nativeError = error;
  }
  let observation: TagObservation | null = null;
  try {
    observation = await observeTag(root, tag);
  } catch (error) {
    result.diagnostics.push({
      code: "tag-state-unknown",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const readback = classifyTagReadback(observation, head);
  result.created = readback.created;
  result.observed_target = readback.observed_target;
  if (nativeError) {
    throw nativeError;
  }
  if (
    !native ||
    native.exit_code !== 0 ||
    native.cancelled ||
    native.truncated ||
    signal.aborted ||
    !readback.verified
  ) {
    throw new ReleaseError(
      "tag-create-incomplete",
      native?.stderr || "Tag creation could not be verified; inspect created and observed_target before retrying",
    );
  }
  result.success = true;
  result.status = "success";
}
export async function tagRepository(
  cwd: string,
  input: unknown = {},
  signal = new AbortController().signal,
): Promise<ReleaseResult> {
  const result = emptyReleaseResult(cwd);
  result.created = false;
  let started = false;
  try {
    releaseSchemas.tag.parse(input);
    await withReleaseRepository(cwd, signal, async (repo) => {
      result.root = repo.git.root;
      result.participants = repo.participants;
      await assertClean(result.root, signal);
      const head = (await gitText(result.root, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
      const branch = await currentBranch(result.root, signal);
      const version = await committedRelease(repo, head, signal),
        tag = `v${version}`;
      result.target_version = version;
      result.tag = tag;
      result.end_commit = head;
      result.changelog_file = repo.config.release.changelog_file;
      const local = await observeTag(result.root, tag, signal);
      if (local.exists) {
        result.observed_target = local.target;
        throw new ReleaseError("tag-already-exists", `Local tag ${tag} already exists`);
      }
      await assertNewerVersion(result.root, head, version, signal);
      const remotes = (await gitText(result.root, ["remote"], signal)).trim().split("\n");
      if (!remotes.includes(repo.config.release.remote)) {
        throw new ReleaseError("remote-not-configured", "Configure the selected Git remote before tagging");
      }
      const remote = parseReleaseRemote(
        await gitText(
          result.root,
          ["ls-remote", "--symref", repo.config.release.remote, "HEAD", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
          signal,
        ),
        tag,
      );
      result.default_branch = remote.branch;
      if (remote.tag !== null) {
        result.observed_target = remote.tag;
      }
      assertReleaseRemote(remote, branch, head);
      await assertClean(result.root, signal);
      await assertHead(result.root, head, signal);
      if ((await currentBranch(result.root, signal)) !== branch) {
        throw new ReleaseError("branch-changed", "Current branch changed before tag creation");
      }
      signal.throwIfAborted();
      started = true;
      await createAndReadTag(result.root, tag, head, result, signal);
    });
  } catch (error) {
    failRelease(result, error, signal.aborted || result.native_steps.some((step) => step.result.cancelled), started);
  }
  return releaseResponse(result);
}
