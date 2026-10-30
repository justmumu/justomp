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
import { readInventory } from "../../../src/dependencies/inventory";
import type { Adapter } from "../../../src/dependencies/model";
import { withDomains } from "../../../src/dependencies/queue";
import { executeDependency } from "../../../src/dependencies/service";
import { closePackagingStructure } from "../../../src/packaging/get-structure";

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalEnvironment = process.env.UV_PROJECT_ENVIRONMENT;
afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalEnvironment === undefined)
    delete process.env.UV_PROJECT_ENVIRONMENT;
  else process.env.UV_PROJECT_ENVIRONMENT = originalEnvironment;
  await closePackagingStructure();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporaryRoot() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-domains-")),
  );
  roots.push(root);
  return root;
}
async function fixture() {
  const root = await temporaryRoot();
  await mkdir(join(root, "bin"));
  for (const name of ["a", "b"]) {
    await mkdir(join(root, name));
    await writeFile(
      join(root, name, "pyproject.toml"),
      `[project]\nname="${name}"\nversion="1"\n[tool.uv]\nrequired-version="==0.11.6"\n`,
    );
  }
  // A controlled native process holds a real filesystem write area until released.
  await writeFile(
    join(root, "bin", "uv"),
    `#!${process.execPath}
import { mkdir, writeFile, access, rm } from "node:fs/promises";
import { join, basename } from "node:path";
const root = ${JSON.stringify(root)};
if (process.argv.includes("--version")) { await writeFile(join(root, "probed"), "probe"); console.log("uv 0.11.6"); process.exit(0); }
const lock = join(root, "active-writer");
try { await mkdir(lock); } catch { process.exit(23); }
await writeFile(join(root, basename(process.cwd()) + "-started"), "started");
while (true) {
  try { await access(join(root, "release")); break; } catch { await Bun.sleep(10); }
}
await rm(lock, { recursive: true });
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${join(root, "bin")}:${originalPath}`;
  return root;
}
const adapter: Adapter = {
  groups: ["runtime"],
  inventory: (context) => readInventory(context.root, context.project),
  plan: async (context) => ({
    metadata: [context.project.manifest],
    affectedProjects: [context.project.project_id],
    steps: [{ label: "controlled mutation", args: ["sync"] }],
  }),
};
function sync(root: string, name: string) {
  return executeDependency(
    root,
    "sync",
    { project_id: `python:${name}/pyproject.toml` },
    { uv: adapter },
  );
}
async function started(root: string, name: string) {
  for (let i = 0; i < 200; i++) {
    try {
      await readFile(join(root, `${name}-started`));
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error("Controlled process did not start");
}
test.each(["absolute", "symlink parent"])(
  "distinct uv roots serialize writes to the same %s environment",
  async (kind) => {
    const root = await fixture();
    if (kind === "absolute")
      process.env.UV_PROJECT_ENVIRONMENT = join(root, "shared-env");
    else {
      await mkdir(join(root, "shared"));
      await symlink(join(root, "shared"), join(root, "a", "env"));
      await symlink(join(root, "shared"), join(root, "b", "env"));
      process.env.UV_PROJECT_ENVIRONMENT = "env/not-created-yet";
    }
    const first = sync(root, "a");
    await started(root, "a");
    const second = sync(root, "b");
    await Bun.sleep(200);
    await writeFile(join(root, "release"), "release");
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.outcome)).toEqual([
      "success",
      "success",
    ]);
    expect(await readFile(join(root, "b-started"), "utf8")).toBe("started");
  },
);
test("a default .venv symlink outside the root is rejected before native mutation", async () => {
  const root = await fixture();
  const outside = await temporaryRoot();
  delete process.env.UV_PROJECT_ENVIRONMENT;
  await symlink(outside, join(root, "a", ".venv"));
  await writeFile(join(root, "release"), "release");
  const result = await sync(root, "a");
  expect(result.outcome).toBe("rejected");
  expect(result.diagnostics?.[0]?.code).toBe("outside-root");
  await expect(readFile(join(root, "a-started"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a changed environment after queue acquisition requeues before probing or mutation", async () => {
  const root = await fixture();
  const oldEnvironment = join(root, "old-env");
  const newEnvironment = join(root, "new-env");
  process.env.UV_PROJECT_ENVIRONMENT = oldEnvironment;
  let releaseOwner!: () => void;
  let releaseNew!: () => void;
  let ownerAcquired!: () => void;
  let newAcquired!: () => void;
  const ownerReady = new Promise<void>((resolve) => {
    ownerAcquired = resolve;
  });
  const newReady = new Promise<void>((resolve) => {
    newAcquired = resolve;
  });
  const ownerLease = withDomains(
    [`write:${join(root, "a")}`],
    undefined,
    async () => {
      ownerAcquired();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    },
  );
  const newLease = withDomains(
    [`write:${newEnvironment}`],
    undefined,
    async () => {
      newAcquired();
      await new Promise<void>((resolve) => {
        releaseNew = resolve;
      });
    },
  );
  await Promise.all([ownerReady, newReady]);
  const pending = sync(root, "a");
  try {
    await Bun.sleep(100);
    process.env.UV_PROJECT_ENVIRONMENT = newEnvironment;
    releaseOwner();
    await ownerLease;
    await Bun.sleep(100);
    await expect(readFile(join(root, "a-started"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(root, "probed"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await writeFile(join(root, "release"), "release");
    releaseOwner();
    releaseNew();
    await Promise.all([ownerLease, newLease]);
  }
  expect((await pending).outcome).toBe("success");
});
