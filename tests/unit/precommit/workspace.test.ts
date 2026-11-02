import { expect, test } from "bun:test";
import { workspaceIncludesGitlink } from "../../../src/precommit/workspace";

test("native Go use paths and root modules are literal normalized memberships", () => {
  expect(workspaceIncludesGitlink({ kind: "go", includes: ["./app"], excludes: [] }, "app")).toBe(true);
  expect(workspaceIncludesGitlink({ kind: "go", includes: ["."], excludes: [] }, "vendor")).toBe(false);
  expect(workspaceIncludesGitlink({ kind: "go", includes: ["./app/module"], excludes: [] }, "app")).toBe(true);
});
test("workspace globs match members, not all descendants of included packages", () => {
  const definition = {
    kind: "npm" as const,
    includes: ["apps/*"],
    excludes: [],
  };
  expect(workspaceIncludesGitlink(definition, "apps/api")).toBe(true);
  expect(workspaceIncludesGitlink(definition, "apps/api/vendor")).toBe(false);
  expect(workspaceIncludesGitlink({ ...definition, excludes: ["apps/api"] }, "apps/api")).toBe(false);
  expect(workspaceIncludesGitlink({ ...definition, includes: ["apps/vendor/*"] }, "apps/vendor")).toBe(true);
});
