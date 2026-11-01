import { COMMIT_DEFAULTS } from "./defaults";
import type { CommitPolicy } from "./model";
export function resolveCommitConfig(raw: unknown): {
  policy: CommitPolicy;
  missing: boolean;
} {
  if (
    raw !== undefined &&
    (!raw || typeof raw !== "object" || Array.isArray(raw))
  )
    throw new Error("commit must be an object");
  const source = (raw ?? {}) as Record<string, unknown>;
  const policy = { ...structuredClone(COMMIT_DEFAULTS), ...source };
  if (
    !Number.isSafeInteger(policy.header_max_length) ||
    policy.header_max_length < 1
  )
    throw new Error("commit.header_max_length must be a positive integer");
  for (const key of ["types", "ignore_prefixes"] as const)
    if (
      !Array.isArray(policy[key]) ||
      policy[key].some(
        (value) =>
          typeof value !== "string" || !value.length || /[\r\n\0]/.test(value),
      )
    )
      throw new Error(
        `commit.${key} must be an array of nonempty single-line strings`,
      );
  return {
    policy,
    missing: Object.keys(COMMIT_DEFAULTS).some(
      (key) => !Object.hasOwn(source, key),
    ),
  };
}
