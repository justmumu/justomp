import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmAdapter } from "../../../src/dependencies/adapters/npm";
import { executeDependency } from "../../../src/dependencies/service";
import { validateExistingSources } from "../../../src/dependencies/source-boundaries";
import {
  closePackagingStructure,
  getPackagingStructure,
} from "../../../src/packaging/get-structure";

const roots: string[] = [];
afterEach(async () => {
  await closePackagingStructure();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-source-boundary-")),
  );
  roots.push(base);
  const root = join(base, "project"),
    outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(
    join(outside, "package.json"),
    JSON.stringify({ name: "linked", version: "1.0.0" }),
  );
  await symlink(outside, join(root, "linked"));
  return { root, outside };
}
test("existing npm local symlink is rejected before any native mutation", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "safe"));
  await writeFile(
    join(root, "safe/package.json"),
    JSON.stringify({ name: "safe", version: "1.0.0" }),
  );
  const manifest = JSON.stringify({
    name: "fixture",
    packageManager: "npm@11.12.1",
    dependencies: { linked: "file:./linked" },
  });
  await writeFile(join(root, "package.json"), manifest);
  const result = await executeDependency(
    root,
    "add",
    {
      project_id: "javascript:package.json",
      group: { kind: "runtime" },
      packages: [{ name: "safe", source: { kind: "path", path: "safe" } }],
    },
    { npm: npmAdapter },
  );
  expect(result.outcome).toBe("rejected");
  expect(result.diagnostics?.[0]?.code).toBe("outside-root");
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest);
});
test("inherited and conditional uv local sources retain their declaration base", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "apps/api"), { recursive: true });
  await writeFile(
    join(root, "pyproject.toml"),
    '[tool.uv.workspace]\nmembers=["apps/*"]\n[tool.uv.sources]\nlinked=[{path="linked",marker="sys_platform == \'darwin\'"}]\n',
  );
  await writeFile(
    join(root, "apps/api/pyproject.toml"),
    '[project]\nname="api"\nversion="1.0"\ndependencies=["linked"]\n',
  );
  const result = await executeDependency(
    root,
    "sync",
    { project_id: "python:apps/api/pyproject.toml" },
    {},
  );
  expect(result.diagnostics?.[0]?.code).toBe("outside-root");
});
test("Go work replacements are canonicalized even when not direct declarations", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "app"));
  await writeFile(
    join(root, "go.work"),
    "go 1.25\nuse ./app\nreplace example.test/linked => ./linked\n",
  );
  await writeFile(
    join(root, "app/go.mod"),
    "module example.test/app\ngo 1.25\n",
  );
  const result = await executeDependency(
    root,
    "sync",
    { project_id: "go:app/go.mod" },
    {},
  );
  expect(result.diagnostics?.[0]?.code).toBe("outside-root");
});

async function validate(root: string, id: string) {
  const { structure } = await getPackagingStructure(root, { refresh: true });
  const project = structure.projects.find((item) => item.project_id === id);
  if (!project) throw new Error(`Missing fixture project ${id}`);
  await validateExistingSources(root, project, structure);
}

test("existing in-root symlink sources remain supported", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "safe"));
  await writeFile(
    join(root, "safe/package.json"),
    JSON.stringify({ name: "safe", version: "1.0.0" }),
  );
  await symlink(join(root, "safe"), join(root, "alias"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "npm@11.12.1",
      dependencies: { safe: "file:./alias" },
    }),
  );
  await expect(
    validate(root, "javascript:package.json"),
  ).resolves.toBeUndefined();
});

test("uv inherited safe paths use the owner rather than member directory", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "apps/api"), { recursive: true });
  await mkdir(join(root, "shared"));
  await symlink(join(root, "linked"), join(root, "apps/api/shared"));
  await writeFile(
    join(root, "pyproject.toml"),
    '[tool.uv.workspace]\nmembers=["apps/*"]\n[tool.uv.sources]\nshared=[{path="shared",marker="sys_platform == \'darwin\'"}]\n',
  );
  await writeFile(
    join(root, "apps/api/pyproject.toml"),
    '[project]\nname="api"\nversion="1.0"\ndependencies=["shared"]\n',
  );
  await expect(
    validate(root, "python:apps/api/pyproject.toml"),
  ).resolves.toBeUndefined();
});

test("unused go.mod replacements use the declaring module directory", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "app"));
  await writeFile(join(root, "go.work"), "go 1.25\nuse ./app\n");
  await writeFile(
    join(root, "app/go.mod"),
    "module example.test/app\ngo 1.25\nreplace example.test/linked => ../linked\n",
  );
  await expect(validate(root, "go:app/go.mod")).rejects.toMatchObject({
    code: "outside-root",
  });
});
