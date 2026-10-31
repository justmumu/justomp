import { expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  extractProtectedToolTargets,
  normalizeProtectionTarget,
} from "../../../src/omp/protected-targets";

test("only general file mutations are inspected; custom tools and eval are untouched", () => {
  for (const name of ["dependency_add", "eval", "read", "bash"])
    expect(
      extractProtectedToolTargets(name, { path: "package.json" }),
    ).toBeNull();
  expect(
    extractProtectedToolTargets("write", { path: "[package.json#abcd]" }),
  ).toEqual(["package.json"]);
});

test("patch edit includes both the source and rename destination", () => {
  expect(
    extractProtectedToolTargets(
      "edit",
      {
        path: "source.ts",
        edits: [{ op: "update", rename: "package.json", diff: "-a\n+b" }],
      },
      "patch",
    ),
  ).toEqual(["source.ts", "package.json"]);
});

test("textual multi-file patch owns the targets, not forged compatibility fields", () => {
  const input = {
    path: "harmless.ts",
    paths: ["also-harmless.ts"],
    input:
      "*** Begin Patch\n*** Add File: source.ts\n+ok\n*** Update File: old.ts\n*** Move to: package.json\n@@\n-old\n+new\n*** Delete File: uv.lock\n*** End Patch",
  };
  expect(extractProtectedToolTargets("edit", input, "apply_patch")).toEqual([
    "source.ts",
    "old.ts",
    "uv.lock",
    "package.json",
  ]);
  expect(extractProtectedToolTargets("apply_patch", input)).toEqual([
    "source.ts",
    "old.ts",
    "uv.lock",
    "package.json",
  ]);
});

test("covered tools refuse unknown targets and modes instead of allowing an empty check", () => {
  expect(() => extractProtectedToolTargets("write", {})).toThrow();
  expect(() => extractProtectedToolTargets("write", { path: "" })).toThrow();
  expect(() =>
    extractProtectedToolTargets(
      "edit",
      { path: "safe.ts", input: "invalid" },
      "hashline",
    ),
  ).toThrow();
  expect(() =>
    extractProtectedToolTargets("edit", { path: "safe.ts" }),
  ).toThrow();
});

test("native path spellings normalize before matching, unsupported URLs refuse", () => {
  expect(normalizeProtectionTarget("@/repo/package.json", "/repo")).toBe(
    "/repo/package.json",
  );
  expect(normalizeProtectionTarget("file:///repo/package.json", "/repo")).toBe(
    "/repo/package.json",
  );
  expect(normalizeProtectionTarget("~/package.json", "/repo")).toBe(
    `${homedir()}/package.json`,
  );
  expect(normalizeProtectionTarget("../package.json", "/repo/app")).toBe(
    "/repo/package.json",
  );
  expect(() =>
    normalizeProtectionTarget("local://package.json", "/repo"),
  ).toThrow("URL");
  expect(() =>
    normalizeProtectionTarget("local:/package.json", "/repo"),
  ).toThrow("URL");
});

test("container writes include the archive or database being mutated", () => {
  expect(
    extractProtectedToolTargets("write", { path: "bundle.zip:source.ts" }),
  ).toContain("bundle.zip");
  expect(
    extractProtectedToolTargets("write", { path: "data.sqlite:items/1" }),
  ).toContain("data.sqlite");
});
