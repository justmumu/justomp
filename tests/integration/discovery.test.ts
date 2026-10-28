import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectProject } from "../../src/inspect/scan";

const roots: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "justomp-scan-"));
  roots.push(root);
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), text);
  }
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
test("root, nested, mixed, tooling-only and empty projects are content driven", async () => {
  const files = {
    "package.json": '{"name":"root"}',
    "pyproject.toml": '[project]\nname="root-py"\nversion="1"',
    "nested/go.mod": "module example.test/nested\ngo 1.24\n",
    "nested/.git/config": "not read",
    "tooling/pyproject.toml": "[tool.ruff]\nline-length=100",
    "examples/pkg/package.json": '{"name":"example"}',
  };
  const root = await fixture(files);
  const r = await inspectProject({ root });
  expect(r.complete).toBe(true);
  expect(r.projects.map((p) => p.id)).toEqual([
    ".:javascript",
    ".:python",
    "examples/pkg:javascript",
    "nested:go",
  ]);
  expect(r.diagnostics.some((d) => d.code === "tooling-only")).toBe(true);
  for (const [p, text] of Object.entries(files))
    expect(await readFile(join(root, p), "utf8")).toBe(text);
  expect((await inspectProject({ root: await fixture({}) })).projects).toEqual(
    [],
  );
});
test("workspace membership is separate from explicit local dependency", async () => {
  const root = await fixture({
    "package.json": '{"name":"root","packageManager":"pnpm@10.0.0"}',
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "apps/web/package.json":
      '{"name":"web","dependencies":{"ui":"workspace:*"}}',
    "packages/ui/package.json": '{"name":"ui"}',
    "packages/other/package.json": '{"name":"other"}',
  });
  const r = await inspectProject({ root });
  expect(r.workspaces[0]?.members).toContain("packages/ui:javascript");
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["apps/web:javascript", "packages/ui:javascript"],
  ]);
});
test("uv workspace/path and Go required local replace resolve without invented edges", async () => {
  const root = await fixture({
    "pyproject.toml":
      '[project]\nname="root"\nversion="1"\ndependencies=["lib"]\n[tool.uv.workspace]\nmembers=["packages/*"]\n[tool.uv.sources]\nlib={workspace=true}\n',
    "packages/lib/pyproject.toml": '[project]\nname="lib"\nversion="1"',
    "go.work": "go 1.24\nuse (\n ./go/a\n ./go/b\n)\n",
    "go/a/go.mod":
      "module example/a\ngo 1.24\nrequire example/b v1.0.0\nreplace example/b => ../b\nreplace example/unused => ../unused\n",
    "go/b/go.mod": "module example/b\ngo 1.24\n",
  });
  const r = await inspectProject({ root });
  expect(r.complete).toBe(true);
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    [".:python", "packages/lib:python"],
    ["go/a:go", "go/b:go"],
  ]);
  expect(r.workspaces).toHaveLength(2);
});
test("exclusion prunes trees, follows no symlinks and malformed manifests remain partial", async () => {
  const root = await fixture({
    "node_modules/x/package.json": "bad",
    ".hidden/package.json": "{}",
    "a/.venv/package.json": "{}",
    "a/node_modules/x/package.json": "bad",
    "included/package.json": '{"name":"good"}',
    "bad/package.json": "{",
    "alias-target/package.json": '{"name":"target"}',
  });
  await symlink(join(root, "alias-target"), join(root, "alias"));
  const r = await inspectProject({ root });
  expect(r.complete).toBe(false);
  expect(r.projects.map((p) => p.path)).toEqual(["alias-target", "included"]);
  expect(r.metrics.manifestReads).toBe(3);
  expect(r.excluded.some((e) => e.reason === "symlink")).toBe(true);
});
test("ambiguous names, excluded workspace members and conflicting managers are diagnosed", async () => {
  const root = await fixture({
    "pnpm-workspace.yaml": 'packages: ["apps/*", ".hidden"]',
    "package.json": '{"name":"root","packageManager":"npm@10"}',
    "pnpm-lock.yaml": "",
    "apps/a/package.json": '{"name":"same"}',
    "apps/b/package.json": '{"name":"same"}',
    "apps/c/package.json":
      '{"name":"consumer","dependencies":{"same":"workspace:*"}}',
    ".hidden/package.json": '{"name":"hidden"}',
  });
  const r = await inspectProject({ root });
  expect(r.localDependencies).toEqual([]);
  for (const code of [
    "ambiguous-target",
    "excluded-member",
    "manager-conflict",
  ])
    expect(r.diagnostics.some((d) => d.code === code)).toBe(true);
});

test("Go use may point to a sibling inside root and excluded ancestors diagnose lost membership", async () => {
  const root = await fixture({
    "workspace/go.work": "go 1.24\nuse ../sibling\n",
    "sibling/go.mod": "module example/sibling\ngo 1.24\n",
    "pnpm-workspace.yaml": 'packages: ["hidden/*"]',
    "hidden/x/package.json": "{}",
  });
  const r = await inspectProject({
    root,
    rules: { include: ["**/*"], exclude: ["hidden"] },
  });
  expect(r.workspaces.find((w) => w.kind === "go")?.members).toEqual([
    "sibling:go",
  ]);
  expect(r.diagnostics.some((d) => d.code === "excluded-member")).toBe(true);
});

test("uv root sources apply to member dependencies; workspace manager evidence needs no lock", async () => {
  const root = await fixture({
    "pyproject.toml":
      '[project]\nname="root"\nversion="1"\n[tool.uv.workspace]\nmembers=["packages/*"]\n[tool.uv.sources]\nlib={workspace=true}\n',
    "packages/app/pyproject.toml":
      '[project]\nname="app"\nversion="1"\ndependencies=["lib"]\n',
    "packages/lib/pyproject.toml": '[project]\nname="lib"\nversion="1"\n',
    "web/pnpm-workspace.yaml": 'packages: ["app"]',
    "web/app/package.json": '{"name":"web"}',
  });
  const r = await inspectProject({ root });
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["packages/app:python", "packages/lib:python"],
  ]);
  expect(r.projects.find((p) => p.name === "web")?.manager).toBe("pnpm");
  expect(r.projects.find((p) => p.name === "app")?.manager).toBe("uv");
});

test("pnpm native membership defaults to root and wildcard excludes dot names", async () => {
  const root = await fixture({
    "package.json": '{"name":"root"}',
    "pnpm-workspace.yaml": "{}",
    "packages/a/package.json": '{"name":"a"}',
    "packages/.hidden/package.json": '{"name":"hidden"}',
  });
  const rules = { include: ["**/*"], exclude: [] };
  expect(
    (await inspectProject({ root, rules })).workspaces[0]?.members,
  ).toEqual([".:javascript"]);
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    'packages: ["./packages//*"]',
  );
  expect(
    (await inspectProject({ root, rules })).workspaces[0]?.members,
  ).toEqual([".:javascript", "packages/a:javascript"]);
});

test("virtual uv workspace root supplies sources without becoming a project", async () => {
  const root = await fixture({
    "pyproject.toml":
      '[tool.uv.workspace]\nmembers=["packages/*"]\n[tool.uv.sources]\nlib={workspace=true}\nother={path="./local"}\n',
    "packages/app/pyproject.toml":
      '[project]\nname="app"\nversion="1"\ndependencies=["lib", "other"]\n',
    "packages/lib/pyproject.toml": '[project]\nname="lib"\nversion="1"\n',
    "local/pyproject.toml": '[project]\nname="other"\nversion="1"\n',
  });
  const r = await inspectProject({ root });
  expect(r.projects.some((p) => p.path === ".")).toBe(false);
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["packages/app:python", "local:python"],
    ["packages/app:python", "packages/lib:python"],
  ]);
  expect(
    r.diagnostics.some(
      (d) => d.code === "unresolved" && d.evidence?.field === "tool.uv.sources",
    ),
  ).toBe(false);
});

test("nearest nested workspace wins even when directory name has one character", async () => {
  const root = await fixture({
    "pnpm-workspace.yaml": 'packages: ["**"]',
    "top/package.json": '{"name":"lib"}',
    "a/pnpm-workspace.yaml": 'packages: ["*"]',
    "a/lib/package.json": '{"name":"lib"}',
    "a/app/package.json": '{"name":"app","dependencies":{"lib":"workspace:*"}}',
  });
  const r = await inspectProject({ root });
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["a/app:javascript", "a/lib:javascript"],
  ]);
});
