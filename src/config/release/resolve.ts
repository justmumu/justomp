import { posix } from "node:path";
import { RELEASE_DEFAULTS } from "./defaults";
import { type ReleasePolicy } from "./model";

const metadata = new Set([
  "package.json",
  "pyproject.toml",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "uv.lock",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);
function releasePath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character === "\\") ||
    posix.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
    value.toLowerCase() === ".justomp/config.json" ||
    metadata.has(posix.basename(value).toLowerCase())
  ) {
    throw new Error(`release.${label} must be a repository-relative path distinct from managed metadata`);
  }
}
function validateHistoryStart(value: unknown): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "string" || !value || value.startsWith("-") || /[\s\0]/.test(value)) {
    throw new Error("release.history_start must be null or a Git revision");
  }
}
export function resolveReleaseConfig(raw?: unknown): { policy: ReleasePolicy; missing: boolean } {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("release must be an object");
  }
  const source = (raw ?? {}) as Record<string, unknown>;
  const policy = { ...RELEASE_DEFAULTS, ...source };
  releasePath(policy.version_file, "version_file");
  releasePath(policy.changelog_file, "changelog_file");
  const versionPath = policy.version_file.normalize("NFC").toLowerCase();
  const changelogPath = policy.changelog_file.normalize("NFC").toLowerCase();
  if (
    versionPath === changelogPath ||
    versionPath.startsWith(`${changelogPath}/`) ||
    changelogPath.startsWith(`${versionPath}/`)
  ) {
    throw new Error("Release paths must be distinct files");
  }
  if (typeof policy.remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(policy.remote)) {
    throw new Error("release.remote must be a configured Git remote name");
  }
  validateHistoryStart(policy.history_start);
  return { policy, missing: Object.keys(RELEASE_DEFAULTS).some((key) => !Object.hasOwn(source, key)) };
}
