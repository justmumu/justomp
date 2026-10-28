import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES } from "../../src/config/defaults";
import {
  createMatcher,
  isDiscoveryInput,
  validateRules,
} from "../../src/inspect/exclusions";
import { parseGo } from "../../src/inspect/readers/go";

describe("inspection rules", () => {
  test("prunes hidden and dependency names at every depth without guessing generic names", () => {
    const m = createMatcher(DEFAULT_RULES);
    for (const p of [
      ".git",
      "a/.venv/x",
      "node_modules/pkg",
      "a/venv",
      "b/bower_components",
      "a/.file",
    ])
      expect(m.excludes(p)).toBe(true);
    for (const p of ["build", "dist", "vendor", "env", "my_node_modules_notes"])
      expect(m.mayTraverse(p)).toBe(true);
  });
  test("empty arrays replace defaults, exclusion wins and ancestors remain traversable", () => {
    const m = createMatcher({
      include: ["apps/web"],
      exclude: ["apps/web/private"],
    });
    expect(m.mayTraverse("apps")).toBe(true);
    expect(m.includes("apps")).toBe(false);
    expect(m.includes("apps/web/package.json")).toBe(true);
    expect(m.includes("apps/web/private/package.json")).toBe(false);
    expect(m.mayTraverse("packages")).toBe(false);
    expect(
      createMatcher({ include: [], exclude: [] }).mayTraverse("anything"),
    ).toBe(false);
    expect(
      createMatcher({ include: ["**/*"], exclude: [] }).includes(
        ".hidden/package.json",
      ),
    ).toBe(true);
  });
  test("unsupported syntax and nonarrays are errors", () => {
    for (const pattern of [
      "/abs",
      "../escape",
      "!foo",
      "a/{b,c}",
      "a/?",
      "a/[bc]",
      "a\\b",
    ])
      expect(() =>
        validateRules({ include: [pattern], exclude: [] }),
      ).toThrow();
    expect(() => validateRules({ include: null, exclude: [] })).toThrow();
  });
});

test("Go lexer handles comments, blocks and quoted paths", () => {
  const parsed = parseGo(
    'module "example.test/a"\ngo 1.24\nrequire (\n example.test/b v1.2.3 // indirect\n)\nreplace (\n example.test/b => "../b folder"\n example.test/unused => ../unused\n)\n',
    "mod",
  );
  expect(parsed.module).toBe("example.test/a");
  expect(parsed.requires).toEqual([
    { name: "example.test/b", version: "v1.2.3" },
  ]);
  expect(parsed.replaces[0]?.target).toBe("../b folder");
  expect(() => parseGo("module x\nrequire (\n broken\n", "mod")).toThrow();
});

test("include wildcards preserve intermediate matching ancestors", () => {
  const m = createMatcher({ include: ["apps/*/nested"], exclude: [] });
  expect(m.mayTraverse("apps/web")).toBe(true);
  expect(m.includes("apps/web/package.json")).toBe(false);
  expect(m.includes("apps/web/nested/package.json")).toBe(true);
  expect(m.mayTraverse("unrelated/web")).toBe(false);
});

test("ordinary filenames matching Object prototype keys are not discovery metadata", () => {
  for (const name of ["constructor", "toString", "__proto__"])
    expect(isDiscoveryInput(name)).toBe(false);
});
