import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
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
  expect(r.projects.map((p) => p.project_id)).toEqual([
    "go:nested/go.mod",
    "javascript:examples/pkg/package.json",
    "javascript:package.json",
    "python:pyproject.toml",
  ]);
  expect(r.diagnostics.some((d) => d.code === "tooling-only")).toBe(true);
  for (const [p, text] of Object.entries(files))
    expect(await readFile(join(root, p), "utf8")).toBe(text);
  expect((await inspectProject({ root: await fixture({}) })).projects).toEqual(
    [],
  );
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

test("project identity survives rescan, copy and metadata edits but follows the manifest path", async () => {
  const files = {
    "package.json": '{"name":"root"}',
    "pyproject.toml": '[project]\nname="python-root"\nversion="1"',
    "apps/İstanbul api/pyproject.toml": '[project]\nname="api"\nversion="1"',
  };
  const root = await fixture(files);
  const ids = (report: Awaited<ReturnType<typeof inspectProject>>) =>
    report.projects.map((p) => p.project_id);
  const first = await inspectProject({ root });
  expect(first.schemaVersion).toBe(2);
  expect(
    first.projects.filter((p) => p.path === ".").map((p) => p.project_id),
  ).toEqual(["javascript:package.json", "python:pyproject.toml"]);
  expect(ids(await inspectProject({ root }))).toEqual(ids(first));
  expect(ids(await inspectProject({ root: await fixture(files) }))).toEqual(
    ids(first),
  );
  await writeFile(
    join(root, "apps/İstanbul api/pyproject.toml"),
    '[project]\nname="renamed"\nversion="2"',
  );
  expect(ids(await inspectProject({ root }))).toEqual(ids(first));
  await rename(join(root, "apps/İstanbul api"), join(root, "apps/backend"));
  const moved = ids(await inspectProject({ root }));
  expect(moved).toContain("python:apps/backend/pyproject.toml");
  expect(moved).not.toContain("python:apps/İstanbul api/pyproject.toml");
});

test("workspace boundary exclusions and conflicting or unknown manager evidence remain visible", async () => {
  const root = await fixture({
    "package.json":
      '{"name":"root","packageManager":"npm@10.9.0","workspaces":["packages/*",".hidden","alias","../outside"]}',
    "yarn.lock": "",
    "packages/a/package.json": '{"name":"same"}',
    "packages/b/package.json": '{"name":"same"}',
    ".hidden/package.json": "{}",
    "unknown/package.json":
      '{"name":"unknown","packageManager":"custom@1","workspaces":["member"]}',
    "unknown/member/package.json": "{}",
  });
  await symlink(join(root, "packages/a"), join(root, "alias"));
  const report = await inspectProject({ root });
  expect(
    report.projects.some((p) =>
      ["alias", ".hidden", "../outside"].includes(p.path),
    ),
  ).toBe(false);
  expect(
    report.projects.find((p) => p.name === "root")?.manager,
  ).toBeUndefined();
  expect(
    report.projects.find((p) => p.name === "unknown")?.manager,
  ).toBeUndefined();
  expect(report.diagnostics.some((d) => d.code === "manager-conflict")).toBe(
    true,
  );
  expect(report.diagnostics.some((d) => d.code === "unsupported-manager")).toBe(
    true,
  );
});

test("native JavaScript membership retains excluded boundaries without creating targets", async () => {
  const root = await fixture({
    "package.json":
      '{"name":"root","packageManager":"bun@1.4.2","workspaces":["packages/*",".hidden","alias","../outside"]}',
    "packages/app/package.json": '{"name":"app"}',
    ".hidden/package.json": "{}",
  });
  await symlink(join(root, "packages/app"), join(root, "alias"));
  const report = await inspectProject({ root });
  expect(report.workspaces[0]?.members).toEqual([
    "javascript:package.json",
    "javascript:packages/app/package.json",
  ]);
  expect(report.workspaces[0]?.status).toBe("unresolved");
  expect(report.projects.find((p) => p.name === "app")?.workspace).toBe(
    ".:bun",
  );
  for (const code of ["excluded-member", "external-member"])
    expect(report.diagnostics.some((d) => d.code === code)).toBe(true);
});
