import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "./host";

const roots: string[] = [];
const hosts: Awaited<ReturnType<typeof createHost>>[] = [];
async function fixture(empty = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-tools-")));
  roots.push(root);
  await writeFile(
    join(root, ".npmrc"),
    `cache=${join(root, ".npm-cache")}\naudit=false\nfund=false\nignore-scripts=false\n`,
  );
  if (!empty)
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "tool-fixture",
        private: true,
        packageManager: "npm@11.12.1",
      }),
    );
  return root;
}
async function host(root: string, deny: string[] = []) {
  const h = await createHost(root, undefined, deny);
  hosts.push(h);
  return h;
}
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function json(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.findLast((part) => part.type === "text")?.text;
  return JSON.parse(text ?? "null");
}
test("OMP exposes six strict dependency tools with write/exec approval and minimal project discovery", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "pyproject.toml"),
    '[project]\nname="same-directory"\nversion="0.1.0"\n',
  );
  const h = await host(root);
  for (const name of ["list", "add", "remove", "update", "sync"]) {
    expect(
      h.runner.getRegisteredTool(`dependency_${name}`)?.definition.approval,
    ).toBe("exec");
  }
  expect(h.runner.getRegisteredTool("list_projects")?.definition.approval).toBe(
    "write",
  );
  expect(
    json(await h.getTool("list_projects").execute("projects", {})),
  ).toEqual({
    projects: [
      { project_id: "javascript:package.json", relative_path: "." },
      { project_id: "python:pyproject.toml", relative_path: "." },
    ],
  });
  const empty = await host(await fixture(true));
  expect(
    json(await empty.getTool("list_projects").execute("empty", {})),
  ).toEqual({ projects: [] });
});
test("real OMP runner performs native npm discovery, list, add, update, sync and remove", async () => {
  const root = await fixture();
  await mkdir(join(root, "local"));
  await writeFile(
    join(root, "local/package.json"),
    '{"name":"local-tool-package","version":"1.0.0"}',
  );
  const h = await host(root);
  const projects = json(
    await h.getTool("list_projects").execute("projects", {}),
  );
  const project_id = projects.projects.find(
    (p: { relative_path: string }) => p.relative_path === ".",
  ).project_id;
  async function call(operation: string, input: object) {
    const result = await h
      .getTool(`dependency_${operation}`)
      .execute(operation, { project_id, ...input });
    const payload = json(result);
    expect(payload.outcome, JSON.stringify(payload)).toBe("success");
    expect(result.isError).not.toBe(true);
    return payload;
  }
  expect((await call("list", {})).dependencies).toEqual([]);
  await call("add", {
    group: { kind: "runtime" },
    packages: [
      { name: "local-tool-package", source: { kind: "path", path: "local" } },
    ],
  });
  expect((await call("list", {})).dependencies[0].name).toBe(
    "local-tool-package",
  );
  await call("update", { packages: [{ name: "local-tool-package" }] });
  await call("sync", {});
  await call("remove", {
    group: { kind: "runtime" },
    packages: [{ name: "local-tool-package" }],
  });
  expect(
    JSON.parse(await readFile(join(root, "package.json"), "utf8"))
      .dependencies ?? {},
  ).toEqual({});
}, 60_000);
test("host denial prevents dependency exec and schema failures are model-visible", async () => {
  const root = await fixture();
  const before = await readFile(join(root, "package.json"), "utf8");
  const denied = await host(root, ["dependency_add"]);
  await expect(
    denied.getTool("dependency_add").execute("denied", {
      project_id: "javascript:package.json",
      group: { kind: "runtime" },
      packages: [{ name: "blocked", source: { kind: "registry" } }],
    }),
  ).rejects.toThrow();
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(before);
  expect(await Bun.file(join(root, "package-lock.json")).exists()).toBe(false);
  expect(
    await Bun.file(join(root, ".justomp/packaging_structure.json")).exists(),
  ).toBe(false);
  const h = await host(root);
  const result = await h.getTool("dependency_add").execute("invalid", {
    project_id: "javascript:package.json",
    packages: [],
  });
  expect(result.isError).toBe(true);
  expect(json(result).outcome).toBe("rejected");
  expect(json(result).diagnostics.length).toBeGreaterThan(0);
  const unknown = await h
    .getTool("list_projects")
    .execute("unknown-field", { path: root });
  expect(unknown.isError).toBe(true);
  expect(json(unknown).outcome).toBe("rejected");
});

async function lockFixture(root: string) {
  const child = Bun.spawn(
    ["npm", "install", "--package-lock-only", "--ignore-scripts"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Fixture lock failed: ${output} ${error}`);
}
async function blockingFixture() {
  const root = await fixture();
  await lockFixture(root);
  await writeFile(
    join(root, "hold.cjs"),
    `const fs = require('node:fs'); fs.writeFileSync('started', String(process.pid)); process.on('SIGTERM', () => { fs.writeFileSync('stopped', 'yes'); process.exit(0); }); setInterval(() => {}, 1000);`,
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "blocking",
      private: true,
      packageManager: "npm@11.12.1",
      scripts: { preinstall: "node hold.cjs" },
    }),
  );
  return root;
}
async function waitStarted(root: string) {
  const started = join(root, "started");
  const deadline = Date.now() + 10_000;
  while (!(await Bun.file(started).exists())) {
    if (Date.now() > deadline)
      throw new Error("Native lifecycle process did not start");
    await Bun.sleep(20);
  }
  return Number(await readFile(started, "utf8"));
}
for (const transition of ["shutdown", "root change"] as const) {
  test(`session ${transition} cancels and joins a real native process and a queued dependency call`, async () => {
    const root = await blockingFixture();
    const h = await host(root);
    const active = h
      .getTool("dependency_sync")
      .execute("active", { project_id: "javascript:package.json" });
    const pid = await Promise.race([
      waitStarted(root),
      active.then((result) => {
        throw new Error(
          `Native operation ended before script start: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const queued = h
      .getTool("dependency_list")
      .execute("queued", { project_id: "javascript:package.json" });
    // Let the second request reach the shared write-domain queue.
    await Bun.sleep(50);
    if (transition === "shutdown")
      await h.runner.emit({ type: "session_shutdown" });
    else {
      const next = await fixture();
      await h.session.moveTo(next, join(next, ".host/sessions"));
      await h.runner.emit({ type: "session_start" });
      expect(
        json(await h.getTool("list_projects").execute("new-root", {})),
      ).toEqual({
        projects: [
          { project_id: "javascript:package.json", relative_path: "." },
        ],
      });
    }
    const [a, b] = await Promise.all([active, queued]);
    expect(a.isError).toBe(true);
    expect(
      json(a).diagnostics.some((d: { code: string }) => d.code === "cancelled"),
    ).toBe(true);
    expect(json(b).outcome).toBe("cancelled");
    expect(await Bun.file(join(root, "stopped")).exists()).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
}
test("OMP content distinguishes native partial changes and structure refresh failure", async () => {
  const root = await fixture();
  await lockFixture(root);
  await writeFile(
    join(root, "fail.cjs"),
    "require('node:fs').writeFileSync('package.json', '{'); process.exit(1);",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "partial",
      private: true,
      packageManager: "npm@11.12.1",
      scripts: { preinstall: "node fail.cjs" },
    }),
  );
  const h = await host(root);
  const result = await h
    .getTool("dependency_sync")
    .execute("partial", { project_id: "javascript:package.json" });
  expect(result.isError).toBe(true);
  const payload = json(result);
  expect(payload.outcome).toBe("partial_change");
  expect(payload.structure_refresh_error).toBeDefined();
  expect(payload.metadata_changes.length).toBeGreaterThan(0);
  expect(payload.native_steps[0].exit_code).not.toBe(0);
  expect(await readFile(join(root, "package.json"), "utf8")).toBe("{");
}, 30_000);
