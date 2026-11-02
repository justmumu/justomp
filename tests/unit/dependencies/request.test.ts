import { expect, test } from "bun:test";
import { normalizeDependencyRequest } from "../../../src/dependencies/request";
import { parseRequest } from "../../../src/dependencies/schemas";

test("Python aliases cannot target the same declaration twice", () => {
  const request = parseRequest("add", {
    project_id: "python:pyproject.toml",
    group: { kind: "runtime" },
    packages: [
      { name: "Foo_Bar", source: { kind: "registry" } },
      { name: "foo-bar", source: { kind: "registry" } },
    ],
  });
  expect(() => normalizeDependencyRequest(request, "python")).toThrow("duplicate targets");
});
test("JavaScript registry names cannot become repository shorthand", () => {
  const request = parseRequest("add", {
    project_id: "javascript:package.json",
    group: { kind: "runtime" },
    packages: [{ name: "owner/repository", source: { kind: "registry" } }],
  });
  expect(() => normalizeDependencyRequest(request, "javascript")).toThrow("not a valid javascript package name");
});
test("JavaScript exact updates require complete versions", () => {
  const request = parseRequest("update", {
    project_id: "javascript:package.json",
    packages: [{ name: "foo", version: "1.2" }],
  });
  expect(() => normalizeDependencyRequest(request, "javascript")).toThrow("complete major.minor.patch");
});
