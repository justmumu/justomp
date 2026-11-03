import { expect, test } from "bun:test";
import { resolveReleaseConfig } from "../../../src/config/release/resolve";

test("release policy fills only absent attributes and preserves extensions", () => {
  const { policy, missing } = resolveReleaseConfig({ remote: "upstream", extension: true });
  expect(policy).toEqual({
    version_file: "VERSION",
    changelog_file: "CHANGELOG.md",
    remote: "upstream",
    history_start: null,
    extension: true,
  });
  expect(missing).toBe(true);
  expect(resolveReleaseConfig(policy).missing).toBe(false);
  expect(resolveReleaseConfig({ history_start: "abc123", version_file: "meta/version" }).policy.history_start).toBe(
    "abc123",
  );
});
test("release policy rejects invalid values and metadata collisions", () => {
  for (const input of [
    null,
    [],
    { remote: "" },
    { remote: "-oops" },
    { history_start: 3 },
    { version_file: "../VERSION" },
    { version_file: "/VERSION" },
    { version_file: ".git/HEAD" },
    { changelog_file: ".GIT/HEAD" },
    { changelog_file: "apps/web/PACKAGE.JSON" },
    { changelog_file: ".JUSTOMP/CONFIG.JSON" },
    { version_file: "Notes", changelog_file: "notes" },
    { version_file: "Notes", changelog_file: "notes/release.md" },
    { changelog_file: "apps/web/package.json" },
    { version_file: ".justomp/config.json" },
    { version_file: "notes", changelog_file: "notes" },
  ]) {
    expect(() => resolveReleaseConfig(input)).toThrow();
  }
});
