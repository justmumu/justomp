import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blockingFixture, fixture, host, hosts, json, lockFixture, roots, waitStarted } from "./dependencies-fixture";

afterEach(async () => {
  for (const h of hosts.splice(0)) {
    await h.close();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
test("OMP exposes six strict dependency tools with write/exec approval and minimal project discovery", async () => {
  const root = await fixture();
  await writeFile(join(root, "pyproject.toml"), '[project]\nname="same-directory"\nversion="0.1.0"\n');
  const h = await host(root);
  for (const name of ["list", "add", "remove", "update", "sync"]) {
    expect(h.runner.getRegisteredTool(`dependency_${name}`)?.definition.approval).toBe("exec");
  }
  expect(h.runner.getRegisteredTool("list_projects")?.definition.approval).toBe("write");
  expect(
    json<{ projects: { project_id: string; relative_path: string }[] }>(
      await h.getTool("list_projects").execute("projects", {}),
    ),
  ).toEqual({
    projects: [
      { project_id: "javascript:package.json", relative_path: "." },
      { project_id: "python:pyproject.toml", relative_path: "." },
    ],
  });
  const empty = await host(await fixture(true));
  expect(
    json<{ projects: { project_id: string; relative_path: string }[] }>(
      await empty.getTool("list_projects").execute("empty", {}),
    ),
  ).toEqual({ projects: [] });
});
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
  expect(await Bun.file(join(root, ".justomp/packaging_structure.json")).exists()).toBe(false);
  const h = await host(root);
  const result = await h.getTool("dependency_add").execute("invalid", {
    project_id: "javascript:package.json",
    packages: [],
  });
  expect(result.isError).toBe(true);
  expect(json(result).outcome).toBe("rejected");
  expect(json(result).diagnostics.length).toBeGreaterThan(0);
  const invalidCheck = await h.getTool("dependency_sync").execute("invalid-check", {
    project_id: "javascript:package.json",
    check: "true",
  });
  expect(invalidCheck.isError).toBe(true);
  expect(json(invalidCheck).outcome).toBe("rejected");
  const unknown = await h.getTool("list_projects").execute("unknown-field", { path: root });
  expect(unknown.isError).toBe(true);
  expect(json(unknown).outcome).toBe("rejected");
});
for (const transition of ["shutdown", "root change"] as const) {
  test(`session ${transition} cancels and joins a real native process and a queued dependency call`, async () => {
    const root = await blockingFixture();
    const h = await host(root);
    const active = h.getTool("dependency_sync").execute("active", { project_id: "javascript:package.json" });
    const pid = await Promise.race([
      waitStarted(root),
      active.then((result) => {
        throw new Error(`Native operation ended before script start: ${JSON.stringify(result)}`);
      }),
    ]);
    const queued = h.getTool("dependency_list").execute("queued", { project_id: "javascript:package.json" });
    // Let the second request reach the shared write-domain queue.
    await Bun.sleep(50);
    if (transition === "shutdown") {
      await h.runner.emit({ type: "session_shutdown" });
    } else {
      const next = await fixture();
      await h.session.moveTo(next, join(next, ".host/sessions"));
      await h.runner.emit({ type: "session_start" });
      expect(
        json<{ projects: { project_id: string; relative_path: string }[] }>(
          await h.getTool("list_projects").execute("new-root", {}),
        ),
      ).toEqual({
        projects: [{ project_id: "javascript:package.json", relative_path: "." }],
      });
    }
    const [a, b] = await Promise.all([active, queued]);
    expect(a.isError).toBe(true);
    expect(json(a).diagnostics.some((d: { code: string }) => d.code === "cancelled")).toBe(true);
    expect(json(b).outcome).toBe("cancelled");
    expect(await Bun.file(join(root, "stopped")).exists()).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
}
test("OMP content distinguishes native partial changes and structure refresh failure", async () => {
  const root = await fixture();
  await lockFixture(root);
  await writeFile(join(root, "fail.cjs"), "require('node:fs').writeFileSync('package.json', '{'); process.exit(1);");
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
  const checked = await h.getTool("dependency_sync").execute("check", {
    project_id: "javascript:package.json",
    check: true,
  });
  expect(checked.isError).not.toBe(true);
  expect(json(checked).outcome).toBe("success");
  expect(json(checked).requested?.check).toBe(true);
  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).name).toBe("partial");
  const result = await h.getTool("dependency_sync").execute("partial", {
    project_id: "javascript:package.json",
    check: false,
  });
  expect(result.isError).toBe(true);
  const payload = json(result);
  expect(payload.outcome).toBe("partial_change");
  expect(payload.requested?.check).toBe(false);
  expect(payload.structure_refresh_error).toBeDefined();
  expect(payload.metadata_changes?.length).toBeGreaterThan(0);
  expect(payload.native_steps?.[0]).toBeDefined();
  expect(payload.native_steps?.[0]?.exit_code).not.toBe(0);
  expect(await readFile(join(root, "package.json"), "utf8")).toBe("{");
}, 30_000);
