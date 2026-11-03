import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMIT_DEFAULTS } from "../../../src/config/commit/defaults";
import { FORMAT_DEFAULTS } from "../../../src/config/format/defaults";
import { resolveIntegrationTestConfig } from "../../../src/config/integration-test/resolve";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { RELEASE_DEFAULTS } from "../../../src/config/release/defaults";
import { resolveTestConfig } from "../../../src/config/test/resolve";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { getPackagingStatus } from "../../../src/packaging/get-structure";
import { gitText } from "../../../src/precommit/git";
import { createHost } from "./host";

const roots: string[] = [];
const hosts: Awaited<ReturnType<typeof createHost>>[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-omp-")));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"hello"}');
  return root;
}
async function host(root: string, deny = false) {
  const h = await createHost(root, undefined, deny);
  hosts.push(h);
  return h;
}
afterEach(async () => {
  for (const h of hosts.splice(0)) {
    await h.close();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
test("actual OMP loader, session hook and tool share a snapshot in headless mode", async () => {
  const root = await fixture();
  await mkdir(join(root, ".justomp"));
  await writeFile(join(root, ".justomp/config.json"), '{"inspection_rules":{"exclude":[]},"custom":7}');
  const h = await host(root);
  expect(h.registered.definition.approval).toBe("write");
  await h.runner.emit({ type: "session_start" });
  const config = JSON.parse(await readFile(join(root, ".justomp/config.json"), "utf8"));
  expect(config).toEqual({
    inspection_rules: { exclude: [], include: ["**/*"] },
    custom: 7,
    lint: resolveLintConfig().policy,
    format: FORMAT_DEFAULTS,
    typecheck: resolveTypecheckConfig().policy,
    test: resolveTestConfig().policy,
    integration_test: resolveIntegrationTestConfig().policy,
    commit: COMMIT_DEFAULTS,
    release: RELEASE_DEFAULTS,
  });
  const snapshot = JSON.parse(await readFile(join(root, ".justomp/packaging_structure.json"), "utf8"));
  const result = await h.tool.execute("test", {});
  expect(result.isError).not.toBe(true);
  expect(result.details.structure.projects).toEqual(snapshot.projects);
  // Background lint setup may refresh inspection; unchanged explicit getters still share its cache.
  const next = await h.tool.execute("cached", {});
  expect(next.details.structure.projects).toEqual(snapshot.projects);
  expect(result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")).toContain(
    '"name":"hello"',
  );
});
test("nested sessions install both repository hooks without changing tool cwd", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-hook-host-")));
  roots.push(root);
  await gitText(root, ["init", "-q"]);
  const nested = join(root, "nested");
  await mkdir(nested);
  const h = await host(nested);
  expect(h.runner.getRegisteredTool("repo_commit")?.definition.approval).toBe("exec");
  await h.runner.emit({ type: "session_start" });
  const hook = await readFile(join(root, ".git/hooks/pre-commit"), "utf8");
  const push = await readFile(join(root, ".git/hooks/pre-push"), "utf8");
  expect(h.runner.getRegisteredTool("repo_push")).toBeUndefined();
  await h.runner.emit({ type: "session_start" });
  expect(await readFile(join(root, ".git/hooks/pre-commit"), "utf8")).toBe(hook);
  expect(await readFile(join(root, ".git/hooks/pre-push"), "utf8")).toBe(push);
  expect((await h.tool.execute("scope", {})).details.structure.root).toBe(nested);
});
test("host denial prevents the custom tool from writing anything", async () => {
  const root = await fixture();
  const h = await host(root, true);
  await expect(h.tool.execute("denied", {})).rejects.toThrow();
  expect(await Bun.file(join(root, ".justomp/packaging_structure.json")).exists()).toBe(false);
  expect(await Bun.file(join(root, ".justomp/config.json")).exists()).toBe(false);
});
test("startup config error is visible and a later tool call can recover without flushing", async () => {
  const root = await fixture();
  await mkdir(join(root, ".justomp"));
  await writeFile(join(root, ".justomp/config.json"), "{");
  const h = await host(root);
  const log = spyOn(console, "error").mockImplementation(() => {
    /* This supplied callback intentionally has no side effects. */
  });
  try {
    await h.runner.emit({ type: "session_start" });
    expect(log).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
  await writeFile(join(root, ".justomp/config.json"), "{}");
  const result = await h.tool.execute("recover", {});
  expect(result.isError).not.toBe(true);
  expect(await readFile(join(root, ".justomp/config.json"), "utf8")).toBe("{}");
  await writeFile(join(root, "package.json"), "{");
  const failed = await h.tool.execute("bad", { refresh: true });
  expect(failed.isError).toBe(true);
  expect(failed.details.error.code).toBe("incomplete");
});
test("cancelled tool does not publish and shutdown releases watcher resources", async () => {
  const root = await fixture();
  const h = await host(root);
  const controller = new AbortController();
  controller.abort();
  await expect(h.tool.execute("cancel", {}, controller.signal)).rejects.toThrow();
  expect(await Bun.file(join(root, ".justomp/packaging_structure.json")).exists()).toBe(false);
  await h.runner.emit({ type: "session_start" });
  expect(getPackagingStatus(root)?.healthy).toBe(true);
  await h.runner.emit({ type: "session_shutdown" });
  expect(getPackagingStatus(root)).toBeUndefined();
});
test("two sessions preserve config and one shutdown leaves the other watcher alive", async () => {
  const root = await fixture();
  const a = await host(root),
    b = await host(root);
  await Promise.all([a.runner.emit({ type: "session_start" }), b.runner.emit({ type: "session_start" })]);
  await a.runner.emit({ type: "session_shutdown" });
  expect(getPackagingStatus(root)?.healthy).toBe(true);
  expect((await b.tool.execute("still-live", {})).isError).not.toBe(true);
});

test("a session root change releases the old root and inspects the new one", async () => {
  const first = await fixture(),
    second = await fixture();
  const h = await host(first);
  await h.runner.emit({ type: "session_start" });
  await h.session.moveTo(second, join(second, ".host/sessions"));
  await h.runner.emit({ type: "session_start" });
  expect(getPackagingStatus(first)).toBeUndefined();
  expect(getPackagingStatus(second)?.healthy).toBe(true);
  expect((await h.tool.execute("moved", {})).details.structure.root).toBe(
    await import("node:fs/promises").then((fs) => fs.realpath(second)),
  );
});
