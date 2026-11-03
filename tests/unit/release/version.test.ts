import { expect, test } from "bun:test";
import { type ReleaseParticipant } from "../../../src/release/model";
import { nextVersion, resolveCommonVersion } from "../../../src/release/version";

function participant(path: string, version: string | null): ReleaseParticipant {
  return {
    project_id: path,
    path,
    manifest: `${path}/package.json`,
    ecosystem: "javascript",
    version,
    kind: version === null ? "versionless" : "static",
  };
}
test("common release version uses unanimous participants or an explicit repository baseline", () => {
  expect(resolveCommonVersion([participant("api", "1.2.3"), participant("web", "1.2.3")], null, "1.1.0")).toBe("1.2.3");
  expect(resolveCommonVersion([], "2.0.0\n", null)).toBe("2.0.0");
  expect(resolveCommonVersion([], null, "1.0.0")).toBe("1.0.0");
  expect(nextVersion("1.2.3", "minor")).toBe("1.3.0");
});
test("release refuses conflicting or missing baselines without choosing a version", () => {
  expect(() => resolveCommonVersion([participant("api", "1.2.3"), participant("web", "0.9.0")], null, null)).toThrow(
    "api/package.json=1.2.3",
  );
  expect(() => resolveCommonVersion([participant("api", "1.2.3")], "2.0.0\n", null)).toThrow("VERSION=2.0.0");
  expect(() => resolveCommonVersion([], null, null)).toThrow("initial-version-required");
  expect(() => resolveCommonVersion([participant("api", "1.2.3")], null, "2.0.0")).toThrow("newer");
  expect(() => resolveCommonVersion([], "v1.2.3\n", null)).toThrow("canonical");
});

test("common version diagnostics identify the configured version record", () => {
  expect(() => resolveCommonVersion([], null, null, "meta/release-version")).toThrow("meta/release-version");
  expect(() => resolveCommonVersion([], "invalid", null, "meta/release-version")).toThrow("meta/release-version");
  expect(() => resolveCommonVersion([participant("api", "1.2.3")], "2.0.0\n", null, "meta/release-version")).toThrow(
    "meta/release-version=2.0.0",
  );
});
