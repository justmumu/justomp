import { expect, test } from "bun:test";
import { parseRequest } from "../../../src/dependencies/schemas";

const id = "javascript:apps/web/package.json";
test("sync accepts only a boolean check option and preserves its omission", () => {
  expect(parseRequest("sync", { project_id: id })).toEqual({
    operation: "sync",
    project_id: id,
  });
  for (const check of [false, true]) {
    expect(parseRequest("sync", { project_id: id, check })).toEqual({
      operation: "sync",
      project_id: id,
      check,
    });
  }
  for (const check of [null, "true", 1]) {
    expect(() => parseRequest("sync", { project_id: id, check })).toThrow();
  }
  expect(() => parseRequest("list", { project_id: id, check: true })).toThrow();
});
test("group and explicit package selection are mandatory", () => {
  for (const operation of ["add", "remove"] as const) {
    expect(() => parseRequest(operation, { project_id: id, packages: [{ name: "foo" }] })).toThrow();
  }
  for (const packages of [undefined, [], [{ name: "*" }]]) {
    expect(() => parseRequest("update", { project_id: id, packages })).toThrow();
  }
  expect(() => parseRequest("sync", { project_id: id, manager: "npm" })).toThrow();
});
test("exact versions cannot coexist with an explicit mode and mixed defaults remain explicit", () => {
  expect(() =>
    parseRequest("update", {
      project_id: id,
      mode: "latest",
      packages: [{ name: "foo", version: "1.0.0" }],
    }),
  ).toThrow();
  expect(() =>
    parseRequest("update", {
      project_id: id,
      packages: [{ name: "foo", version: "^1.0" }],
    }),
  ).toThrow();
  expect(
    parseRequest("update", {
      project_id: id,
      packages: [{ name: "foo", version: "1.0.0" }, { name: "bar" }],
    }).operation,
  ).toBe("update");
  expect(() =>
    parseRequest("update", {
      project_id: id,
      packages: [{ name: "foo" }, { name: "foo" }],
    }),
  ).toThrow();
});
test("source and group discriminants reject conflicting fields", () => {
  const add = (source: unknown, group: unknown = { kind: "runtime" }) =>
    parseRequest("add", {
      project_id: id,
      group,
      packages: [{ name: "foo", source }],
    });
  expect(() => add({ kind: "registry", path: "foo" })).toThrow();
  expect(() => add({ kind: "path", path: "../outside" })).toThrow();
  expect(() => add({ kind: "registry" }, { kind: "named" })).toThrow();
  expect(() => add({ kind: "registry" }, { kind: "dev", name: "foo" })).toThrow();
  expect(
    add({
      kind: "workspace",
      target_project_id: "javascript:packages/foo/package.json",
    }).operation,
  ).toBe("add");
});
