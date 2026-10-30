import { expect, test } from "bun:test";
import { parseInventory } from "../../../src/dependencies/inventory";
import { context } from "./adapters/npm-pnpm-fixture";

function inventory(file: string, text: string) {
  const project = context("npm").project;
  return parseInventory(
    {
      ...project,
      path: ".",
      managerRoot: ".",
      manifest: file,
      ecosystem:
        file === "package.json"
          ? "javascript"
          : file === "go.mod"
            ? "go"
            : "python",
    },
    text,
  );
}
test("JS group occurrences and source provenance are kept without installation", async () => {
  const result = await inventory(
    "package.json",
    JSON.stringify({
      name: "app",
      dependencies: { foo: "^1.0.0", ui: "workspace:*" },
      devDependencies: { foo: "^2.0.0" },
    }),
  );
  expect(
    result.dependencies
      .filter((d) => d.name === "foo")
      .map((d) => d.group.kind),
  ).toEqual(["runtime", "dev"]);
  expect(result.dependencies.find((d) => d.name === "ui")?.source.kind).toBe(
    "workspace",
  );
  expect(result.dependencies.every((d) => d.resolutions === undefined)).toBe(
    true,
  );
});
test("Python requirements keep extras, markers, groups and native sources", async () => {
  const result = await inventory(
    "pyproject.toml",
    '[project]\nname="app"\nversion="1"\ndependencies=["Foo[bar]>=1,<2; python_version < \'3.14\'"]\n[dependency-groups]\ndev=["foo>=2"]\n[tool.uv.sources]\nfoo={git="https://example.test/foo",rev="abc"}\n',
  );
  expect(result.dependencies).toHaveLength(2);
  expect(result.dependencies[0]?.extras).toEqual(["bar"]);
  expect(result.dependencies[0]?.marker).toContain("python_version");
  expect(result.dependencies.every((d) => d.source.kind === "git")).toBe(true);
});
test("Go indirect declarations are not presented as direct packages or checksum graphs", async () => {
  const result = await inventory(
    "go.mod",
    "module example.test/app\ngo 1.25\nrequire (\n example.test/a v1.0.0\n example.test/b v2.0.0 // indirect\n)\nreplace example.test/a => ./local\n",
  );
  expect(
    result.dependencies.filter((d) => d.direct).map((d) => d.name),
  ).toEqual(["example.test/a"]);
  expect(result.dependencies[0]?.source.kind).toBe("path");
});
