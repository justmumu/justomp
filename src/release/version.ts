import { gt, inc, valid } from "semver";
import { ReleaseError, type ReleaseParticipant } from "./model";
import { type Increment } from "./schemas";

export function canonicalVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ||
    valid(value) !== value
  ) {
    throw new ReleaseError("invalid-version", `${label} must contain a canonical stable X.Y.Z version`);
  }
  return value;
}
export function resolveCommonVersion(
  participants: readonly ReleaseParticipant[],
  versionText: string | null,
  reachableTagVersion: string | null,
  versionFile = "VERSION",
): string {
  const records = participants
    .filter((participant) => participant.version !== null)
    .map((participant) => ({
      path: participant.manifest,
      version: canonicalVersion(participant.version, participant.manifest),
    }));
  if (versionText !== null) {
    records.unshift({
      path: versionFile,
      version: canonicalVersion(versionText.endsWith("\n") ? versionText.slice(0, -1) : versionText, versionFile),
    });
  }
  const versions = new Set(records.map((record) => record.version));
  if (versions.size > 1) {
    throw new ReleaseError(
      "version-conflict",
      `Common release versions disagree: ${records.map((record) => `${record.path}=${record.version}`).join(", ")}`,
    );
  }
  const baseline =
    records[0]?.version ?? (reachableTagVersion === null ? null : canonicalVersion(reachableTagVersion, "Release tag"));
  if (baseline === null) {
    throw new ReleaseError(
      "initial-version-required",
      `initial-version-required: choose a common version in ${versionFile} and commit it before releasing`,
    );
  }
  if (reachableTagVersion !== null && gt(canonicalVersion(reachableTagVersion, "Release tag"), baseline)) {
    throw new ReleaseError(
      "version-conflict",
      `Release tag ${reachableTagVersion} is newer than common version ${baseline}`,
    );
  }
  return baseline;
}
export function nextVersion(version: string, increment: Increment): string {
  const result = inc(canonicalVersion(version, "Current version"), increment);
  if (!result) {
    throw new ReleaseError("invalid-version", "The requested version increment cannot be represented");
  }
  return canonicalVersion(result, "Target version");
}
