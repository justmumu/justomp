import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { assertLocalPreparation, createLocalHost } from "./local-checkers";
import { cleanups, fixture, heldRegistry, json, registry, until } from "./typecheck-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("OMP typecheck has strict ID-only exec schema; denial and unknown IDs cannot prepare", async () => {
  const { f, h } = await fixture();
  const registered = h.runner.getRegisteredTool("project_typecheck");
  if (!registered) {
    throw new Error("Missing project_typecheck registration");
  }
  expect(registered.definition.approval).toBe("exec");
  expect(
    (
      registered.definition.parameters as {
        safeParse(value: unknown): { success: boolean };
      }
    ).safeParse({
      project_id: "python:pyproject.toml",
      manager: "uv",
    }).success,
  ).toBe(false);
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Must not prepare"));
  try {
    const result = await h
      .getTool("project_typecheck")
      .execute("unknown", { project_id: "python:moved/pyproject.toml" });
    expect(result.isError).toBe(true);
    expect(json<{ error: { code: string } }>(result).error.code).toBe("project-not-found");
    expect(network).not.toHaveBeenCalled();
    expect(await Bun.file(join(f.root, ".justomp/config.json")).exists()).toBe(false);
  } finally {
    network.mockRestore();
  }
  const denied = await fixture(["project_typecheck"]);
  await expect(
    denied.h.getTool("project_typecheck").execute("deny", { project_id: "python:pyproject.toml" }),
  ).rejects.toThrow();
  expect(await Bun.file(join(denied.f.root, ".justomp/config.json")).exists()).toBe(false);
});
test("plain inspection and empty-root startup never install typecheck tools", async () => {
  const { f, h } = await fixture();
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("No setup expected"));
  try {
    expect((await h.tool.execute("plain", {})).isError).not.toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(await Bun.file(join(f.root, ".justomp/typecheck_state.json")).exists()).toBe(false);
    await unlink(join(f.root, "pyproject.toml"));
    await h.runner.emit({ type: "session_start" });
    await h.close();
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
test("releasing one session cancels its preparation waiter but preserves another session's job", async () => {
  const { f, h } = await fixture([], true);
  const second = await createLocalHost(f.root);
  cleanups.push(second.close);
  const network = heldRegistry();
  try {
    await Promise.all([h.runner.emit({ type: "session_start" }), second.runner.emit({ type: "session_start" })]);
    await until(async () => network.entered(), "shared setup did not start");
    let waitingStarted = false;
    const waiting = h
      .getTool("project_typecheck")
      .execute("wait", { project_id: "python:pyproject.toml" }, undefined, () => {
        waitingStarted = true;
      });
    await until(async () => waitingStarted, "tool preparation waiter did not start");
    await Promise.race([
      h.close(),
      Bun.sleep(2000).then(() => {
        throw new Error("shutdown waited on another session's setup");
      }),
    ]);
    const cancelled = json(await waiting);
    expect(cancelled.cancelled, JSON.stringify(cancelled)).toBe(true);
    expect(network.calls()).toBe(1);
    network.release();
    const result = json(
      await second.getTool("project_typecheck").execute("remaining", { project_id: "python:pyproject.toml" }),
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    await assertLocalPreparation(f.root, "pyright");
  } finally {
    network.release();
    await second.close();
    network.fetcher.mockRestore();
  }
}, 30000);
test("cancelled new setup wait never reports a previous job's changes", async () => {
  const { f, h } = await fixture([], true);
  const firstRegistry = registry();
  try {
    expect(
      json(await h.getTool("project_typecheck").execute("first", { project_id: "python:pyproject.toml" })).preparation
        .changes.length,
    ).toBeGreaterThan(0);
    await assertLocalPreparation(f.root, "pyright");
  } finally {
    firstRegistry.mockRestore();
  }
  const network = heldRegistry();
  try {
    await mkdir(join(f.root, "new"));
    await writeFile(
      join(f.root, "new/pyproject.toml"),
      '[project]\nname="later"\nversion="0.1.0"\n[tool.uv]\npackage=false\n',
    );
    await until(async () => network.entered(), "new wave did not start");
    const controller = new AbortController();
    let entered = false;
    const waiting = h
      .getTool("project_typecheck")
      .execute("cancel", { project_id: "python:pyproject.toml" }, controller.signal, () => {
        entered = true;
      });
    await until(async () => entered, "tool wait did not begin");
    controller.abort(new Error("Caller cancelled"));
    const result = json(await waiting);
    expect(result.cancelled).toBe(true);
    expect(result.project_id).toBe("python:pyproject.toml");
    expect(result.preparation.changes).toEqual([]);
    expect(result.preparation.errors.some((error: { message: string }) => error.message.includes("may continue"))).toBe(
      true,
    );
  } finally {
    await h.close();
    network.release();
    network.fetcher.mockRestore();
  }
}, 30000);
test("session policy updates reproject typecheck without a new tool version wave", async () => {
  const { f, h } = await fixture([], true),
    network = registry();
  try {
    expect(
      json(await h.getTool("project_typecheck").execute("first", { project_id: "python:pyproject.toml" })).success,
    ).toBe(true);
    await assertLocalPreparation(f.root, "pyright");
    const path = join(f.root, ".justomp/config.json"),
      config = JSON.parse(await readFile(path, "utf8"));
    config.typecheck.python.pyright.diagnostics.reportUnusedImport = "warning";
    await writeFile(path, JSON.stringify(config));
    await until(async () => {
      const native = parse(await readFile(join(f.root, "pyproject.toml"), "utf8")) as {
        tool?: { pyright?: { reportUnusedImport?: string } };
      };
      return native.tool?.pyright?.reportUnusedImport === "warning";
    }, "policy was not reprojected");
    expect(network.mock.calls.filter((call) => String(call[0]).includes("pyright/json")).length).toBe(1);
  } finally {
    await h.close();
    network.mockRestore();
  }
}, 30000);

test("startup returns before adapter setup, reports progress, and discovers new Python manifests", async () => {
  const { f, h } = await fixture([], true);
  const network = heldRegistry();
  const messages: string[] = [];
  const log = spyOn(process.stdout, "write").mockImplementation((value) => {
    messages.push(String(value));
    return true;
  });
  try {
    const start = performance.now();
    await h.runner.emit({ type: "session_start" });
    expect(performance.now() - start).toBeLessThan(1000);
    await until(async () => network.entered(), "background resolution did not start");
    expect(messages.some((m) => m.includes("common exact tool versions"))).toBe(true);
    const pendingState = Bun.file(join(f.root, ".justomp/typecheck_state.json"));
    expect((await pendingState.exists()) ? (await pendingState.json()).waves?.python?.complete : false).not.toBe(true);
    network.release();
    await until(async () => {
      try {
        return (
          JSON.parse(await readFile(join(f.root, ".justomp/typecheck_state.json"), "utf8")).waves?.python?.complete ===
          true
        );
      } catch {
        return false;
      }
    }, "first preparation did not finish");
    await mkdir(join(f.root, "draft"));
    await Bun.sleep(150);
    expect(network.calls()).toBe(1);
    await mkdir(join(f.root, "apps/new"), { recursive: true });
    await writeFile(
      join(f.root, "apps/new/pyproject.toml"),
      '[project]\nname="new-project"\nversion="0.1.0"\nrequires-python=">=3.11"\n[tool.uv]\npackage=false\n',
    );
    await until(async () => {
      const state = JSON.parse(await readFile(join(f.root, ".justomp/typecheck_state.json"), "utf8"));
      return state.waves?.python?.complete && state.projects["python:apps/new/pyproject.toml"]?.ready;
    }, "new Python project did not prepare automatically");
    expect(network.calls()).toBe(2);
    expect(
      messages
        .filter((message) => message.startsWith("justomp typecheck:"))
        .every((message) => !message.includes('"projects":')),
    ).toBe(true);
    await assertLocalPreparation(join(f.root, "apps/new"), "pyright");
  } finally {
    network.release();
    await h.close();
    network.fetcher.mockRestore();
    log.mockRestore();
  }
}, 30000);
