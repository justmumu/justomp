import { expect, test } from "bun:test";
import { parseGo } from "../../../src/inspect/readers/go";
import { readManifest } from "../../../src/inspect/readers/manifest";

test("Go declarations preserve escaped paths, versioned replacements and unresolved metadata", () => {
  expect(
    parseGo(
      'module "example\\x2fapp"\ngo 1.24\nrequire lib v1\nreplace lib v1 => "../l\\151b"\nexclude lib v2\ntoolchain go1.24\n',
      "mod",
    ),
  ).toEqual({
    module: "example/app",
    go: "1.24",
    requires: [{ name: "lib", version: "v1" }],
    replaces: [{ name: "lib", version: "v1", target: "../lib" }],
    uses: [],
    unsupported: ["exclude"],
  });
  expect(parseGo("go 1.24\nuse `../multi\nline`\nreplace lib => remote v2\n", "work").uses).toEqual(["../multi\nline"]);
});

test("Go malformed declarations retain validation at lexical and directive boundaries", () => {
  for (const source of [
    'module "bad\\q"',
    'module "bad\\uD800"',
    'module "bad\nname"',
    'module "unclosed',
    "module x\nmodule y",
    "module x\ngo nope",
    "module x\nrequire only",
    "module x\nreplace x y z",
    "module x\nrequire ( x v1\n)",
    "module x\nrequire (\nx v1\n",
    "module x\nrequire (\nx v1\n) trailing",
  ]) {
    expect(() => parseGo(source, "mod")).toThrow();
  }
  expect(() => parseGo("module x", "work")).toThrow();
  expect(() => parseGo("go 1.24", "mod")).toThrow("no module");
});

test("manifest readers preserve validation order and local dependency classifications", () => {
  const result = readManifest(
    "package.json",
    JSON.stringify({
      packageManager: "custom@1",
      dependencies: {
        react: "^1",
        local: "workspace:../local",
        named: "workspace:^1",
        alias: "workspace:other@*",
        archive: "file:../a",
        linked: "link:../b",
        catalog: "catalog:default",
      },
    }),
  );
  expect(result.project?.project.status).toBe("ambiguous");
  expect(result.project?.project.frameworks).toEqual(["react"]);
  expect(result.project?.references.map((ref) => ref.kind)).toEqual(["workspace-path", "workspace", "file", "link"]);
  expect(result.diagnostics.map((entry) => entry.code)).toEqual(["unsupported-manager", "unresolved", "unresolved"]);
  expect(() => readManifest("package.json", '{"engines":{"node":1},"dependencies":{"bad":2}}')).toThrow("engines.node");
  expect(() => readManifest("package.json", '{"dependencies":{"bad":2}}')).toThrow("dependencies.bad");
  expect(() => readManifest("pyproject.toml", '[project]\nname="x"\n[tool.uv.sources]\nlib={path=1}')).toThrow(
    "tool.uv.sources.lib.path",
  );
});

test("Python sources retain conditional overrides and normalize selected dependency names", () => {
  const result = readManifest(
    "pyproject.toml",
    '[project]\nname="app"\ndependencies=["Foo_Bar", "Flask", "local @ ../lib"]\n[project.optional-dependencies]\ntest=["extra"]\n[dependency-groups]\ndev=["dev", {include-group="test"}]\n[tool.uv.sources]\nFoo_Bar={path="../foo", marker="python_version"}\nextra=[{path="../extra"}]\ndev={workspace=true}\n',
  );
  expect(result.project?.dependencyNames).toEqual(["foo-bar", "flask", "local", "extra", "dev"]);
  expect(result.project?.uvSources?.["foo-bar"]).toBeNull();
  expect(result.project?.uvSources?.extra).toBeNull();
  expect(result.project?.uvSources?.dev?.workspace).toBe(true);
  expect(result.project?.references[0]?.target).toBe("../lib");
  expect(result.project?.project.frameworks).toEqual(["Flask"]);
  expect(result.diagnostics).toHaveLength(2);
});
