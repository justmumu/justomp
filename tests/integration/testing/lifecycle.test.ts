import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import type { TestAdapter } from "../../../src/testing/adapters";
import {
  retainTestCoordinator,
  waitForTestPreparation,
} from "../../../src/testing/coordinator";
import { prepareTests } from "../../../src/testing/prepare";

test("persisted runner waves resume exact versions, align new members, and share session ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-test-lifecycle-"));
  let resolves = 0,
    latest = "1.0.0",
    fail = "",
    prepares = 0,
    preflights = 0;
  const add = async (name: string) => {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, name, "package.json"),
      JSON.stringify({ name, packageManager: "npm@10.9.0" }),
    );
  };
  const adapter: TestAdapter = {
    resolve: async () => {
      resolves++;
      return { vitest: latest };
    },
    preflight: async () => {
      preflights++;
    },
    verify: async ({ target, tools }) => {
      try {
        return (
          (await readFile(join(target.scope.cwd, "installed.json"), "utf8")) ===
          JSON.stringify(tools)
        );
      } catch {
        return false;
      }
    },
    prepare: async ({ target, tools }, changes) => {
      prepares++;
      const state = JSON.parse(
        await readFile(join(root, ".justomp/test_state.json"), "utf8"),
      );
      expect(state.waves.vitest.tools).toEqual(tools);
      if (target.project.path === fail)
        throw new Error("install fixture failure");
      await writeFile(
        join(target.scope.cwd, "installed.json"),
        JSON.stringify(tools),
      );
      changes.push({
        project_id: target.project.project_id,
        path: `${target.project.path}/installed.json`,
        kind: "updated",
      });
    },
    run: async () => {
      throw new Error("startup must not run tests");
    },
  };
  const signal = new AbortController().signal;
  try {
    await add("a");
    expect(
      (await prepareTests(root, { vitest: adapter }, signal)).complete,
    ).toBe(true);
    expect(resolves).toBe(1);
    expect((await prepareTests(root, { vitest: adapter }, signal)).action).toBe(
      "already-ready",
    );
    expect(resolves).toBe(1);
    expect(prepares).toBe(1);
    expect(preflights).toBe(1);
    await add("b");
    latest = "2.0.0";
    fail = "b";
    expect(
      (await prepareTests(root, { vitest: adapter }, signal)).complete,
    ).toBe(false);
    expect(resolves).toBe(2);
    latest = "3.0.0";
    fail = "";
    expect(
      (await prepareTests(root, { vitest: adapter }, signal)).complete,
    ).toBe(true);
    expect(resolves).toBe(2);
    expect(
      JSON.parse(await readFile(join(root, "b/installed.json"), "utf8")),
    ).toEqual({ vitest: "2.0.0" });
    const one = await retainTestCoordinator(root, { vitest: adapter }),
      two = await retainTestCoordinator(root, { vitest: adapter });
    expect(one.coordinator).toBe(two.coordinator);
    await one.release();
    expect(two.coordinator.isClosed).toBe(false);
    expect((await waitForTestPreparation(two.coordinator)).complete).toBe(true);
    await two.release();
    expect(two.coordinator.isClosed).toBe(true);
    await add("c");
    let entered = () => {},
      joined = false;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    adapter.prepare = async ({ signal }) => {
      entered();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      joined = true;
      signal.throwIfAborted();
    };
    const first = await retainTestCoordinator(root, { vitest: adapter }),
      second = await retainTestCoordinator(root, { vitest: adapter });
    try {
      const caller = new AbortController(),
        waiting = waitForTestPreparation(first.coordinator, caller.signal);
      await started;
      caller.abort(new Error("cancel wait"));
      await expect(waiting).rejects.toThrow("cancel wait");
      await first.release();
      expect(second.coordinator.isClosed).toBe(false);
      expect(joined).toBe(false);
      const retained = waitForTestPreparation(second.coordinator);
      await second.release();
      expect(joined).toBe(true);
      expect((await retained).cancelled).toBe(true);
    } finally {
      await first.release();
      await second.release();
    }
  } finally {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
