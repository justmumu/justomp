import { join } from "node:path";
import { changes, type Fingerprints, fingerprint } from "../dependencies/changes";
import { redactValues } from "../dependencies/model";
import { LOCK_MANAGERS } from "../inspect/exclusions";
import { gitText } from "../precommit/git";
import { type NativeReleasePlan } from "./adapters/types";
import { ReleaseError, type ReleaseResult } from "./model";
export function emptyReleaseResult(root: string): ReleaseResult {
  return {
    success: false,
    status: "rejected",
    root,
    cancelled: false,
    changed_files: [],
    affected_projects: [],
    participants: [],
    native_steps: [],
    diagnostics: [],
  };
}
export function failRelease(result: ReleaseResult, error: unknown, cancelled: boolean, started: boolean): void {
  result.success = false;
  result.cancelled = cancelled;
  result.status =
    result.changed_files.length || result.created === true
      ? "partial_change"
      : cancelled
        ? "cancelled"
        : started
          ? "failed"
          : "rejected";
  result.diagnostics.push({
    code: error instanceof Error && "code" in error ? String(error.code) : "release-failed",
    message: error instanceof Error ? error.message : String(error),
  });
}
export function parseChangedPaths(...outputs: string[]): string[] {
  return [...new Set(outputs.flatMap((output) => output.split("\0").filter(Boolean)))].sort();
}
export async function captureReleaseEffects(plan: NativeReleasePlan): Promise<Fingerprints> {
  const paths = [
    plan.repo.config.release.version_file,
    plan.repo.config.release.changelog_file,
    ...plan.repo.manifests.map((manifest) => manifest.project.manifest),
    ...plan.repo.structure.workspaces.map((workspace) => workspace.declaration),
    ...plan.owners.flatMap((owner) =>
      Object.entries(LOCK_MANAGERS)
        .filter(([, manager]) => manager === owner.context.manager)
        .map(([name]) => join(owner.lockBefore.directory, name)),
    ),
  ];
  return await fingerprint(plan.repo.git.root, paths);
}
async function gitChanges(root: string): Promise<string[]> {
  return parseChangedPaths(
    await gitText(root, ["diff", "--name-only", "--no-renames", "--no-ext-diff", "-z", "HEAD", "--"]),
    await gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
}
async function metadataChanges(root: string, before?: Fingerprints): Promise<string[]> {
  if (!before) {
    return [];
  }
  return changes(before, await fingerprint(root, [...before.keys()])).map((change) => change.path);
}
export async function observeReleaseChanges(root: string, result: ReleaseResult, before?: Fingerprints): Promise<void> {
  const observations = await Promise.allSettled([gitChanges(root), metadataChanges(root, before)]);
  result.changed_files = [
    ...new Set(observations.flatMap((observed) => (observed.status === "fulfilled" ? observed.value : []))),
  ].sort();
  const failures = observations.filter((observed): observed is PromiseRejectedResult => observed.status === "rejected");
  if (failures.length) {
    throw new ReleaseError(
      "effects-unknown",
      `Could not fully observe release effects: ${failures.map((failure) => String(failure.reason)).join("; ")}`,
    );
  }
}
export function releaseResponse(result: ReleaseResult): ReleaseResult {
  return redactValues(result);
}
