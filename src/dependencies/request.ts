import { normalizePythonName } from "../inspect/readers/manifest";
import { DependencyError, type Group } from "./model";
import { type DependencyRequest } from "./schemas";

export function validateDependencyGroup(
  request: DependencyRequest,
  groups: readonly Group["kind"][],
  manager: string,
): void {
  if ("group" in request && !groups.includes(request.group.kind)) {
    throw new DependencyError("unsupported-group", `${manager} has no native ${request.group.kind} group`);
  }
}

export function normalizeDependencyRequest(request: DependencyRequest, ecosystem: string): void {
  if (!("packages" in request)) {
    return;
  }
  if (ecosystem === "python") {
    for (const item of request.packages) {
      item.name = normalizePythonName(item.name);
    }
  }
  for (const item of request.packages) {
    const valid =
      ecosystem === "javascript"
        ? /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(item.name)
        : ecosystem !== "python" || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.name);
    if (!valid) {
      throw new DependencyError("invalid-package", `${item.name} is not a valid ${ecosystem} package name`);
    }
  }
  const keys = request.packages.map(
    (item) => `${item.name}:${JSON.stringify("group" in item ? (item.group ?? null) : null)}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new DependencyError("duplicate-dependency", "Package normalization produced duplicate targets");
  }
  if (ecosystem === "javascript" && request.operation === "update") {
    for (const item of request.packages) {
      if (
        item.version &&
        !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
          item.version,
        )
      ) {
        throw new DependencyError(
          "invalid-version",
          "JavaScript exact updates require a complete major.minor.patch version",
        );
      }
    }
  }
}
