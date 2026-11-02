import { expect, spyOn, test } from "bun:test";
import { access, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FSWatcher } from "chokidar";
import { withDomains } from "../../../src/dependencies/queue";
import { runProcess } from "../../../src/dependencies/runner";
import { retainLintCoordinator, withReadyLintTarget } from "../../../src/lint/coordinator";
import { applyLintFix, pendingLintFix } from "../../../src/lint/fix";
import { resolveLintTarget } from "../../../src/lint/targets";
import { getPackagingStructure } from "../../../src/packaging/get-structure";
import { fixture } from "./fixture";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function target(root: string) {
  return resolveLintTarget((await getPackagingStructure(root)).structure, "python:a/pyproject.toml");
}

test("check holds dependency domains and revalidates after waiting behind mutation", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  // Keep the deliberately stale environment from being repaired by the watcher.
  await coordinator.shutdown();
  const selected = await target(f.root);
  const entered = deferred(),
    release = deferred();
  let writerStarted = false;
  const check = withReadyLintTarget(f.root, selected.project.project_id, { python: f.adapter }, async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  await entered.promise;
  const writer = withDomains(selected.scope.domains, undefined, async () => {
    writerStarted = true;
    await rm(join(f.root, "a/installed.json"));
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(writerStarted).toBe(false);
  release.resolve();
  expect(await check).toBe(true);
  await writer;
  await expect(
    withReadyLintTarget(f.root, selected.project.project_id, { python: f.adapter }, async () => true),
  ).rejects.toThrow("not ready");
  const locked = deferred(),
    unlock = deferred();
  const mutation = withDomains(selected.scope.domains, undefined, async () => {
    locked.resolve();
    await unlock.promise;
  });
  await locked.promise;
  let ran = false;
  const waiting = withReadyLintTarget(f.root, selected.project.project_id, { python: f.adapter }, async () => {
    ran = true;
  });
  unlock.resolve();
  await mutation;
  await expect(waiting).rejects.toThrow("not ready");
  expect(ran).toBe(false);
});

test("shutdown aborts the real child and retains the lease until process close", async () => {
  const f = await fixture();
  const entered = deferred();
  const marker = join(f.root, "child-ended");
  f.adapter.prepareBatch = async (context) => {
    const child = runProcess(
      process.execPath,
      [
        "-e",
        `process.on('SIGTERM', () => setTimeout(() => { require('fs').writeFileSync(process.env.ENDED, 'closed'); process.exit(0); }, 80)); require('fs').writeFileSync(process.env.STARTED, 'started'); setInterval(() => {}, 1000);`,
      ],
      {
        cwd: f.root,
        env: {
          ...process.env,
          ENDED: marker,
          STARTED: join(f.root, "child-started"),
        },
        signal: context.signal,
      },
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(join(f.root, "child-started"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    entered.resolve();
    await child;
    context.signal.throwIfAborted();
  };
  const coordinator = await f.start();
  await entered.promise;
  const selected = await target(f.root);
  let wrote = false;
  const writer = withDomains(selected.scope.domains, undefined, async () => {
    expect(await readFile(marker, "utf8")).toBe("closed");
    wrote = true;
  });
  await coordinator.shutdown();
  await writer;
  expect(wrote).toBe(true);
  await expect(coordinator.reconcile()).rejects.toThrow("closed");
});

test("config change during preparation cannot publish a stale ready receipt", async () => {
  const f = await fixture();
  const original = f.adapter.prepareBatch;
  let changed = false;
  f.adapter.prepareBatch = async (context) => {
    await original(context);
    if (!changed) {
      changed = true;
      const path = join(f.root, ".justomp/config.json");
      const config = JSON.parse(await readFile(path, "utf8"));
      config.lint.python.ruff["line-length"] = 101;
      await writeFile(path, JSON.stringify(config));
    }
  };
  const coordinator = await f.start();
  const result = await coordinator.reconcile();
  // An observed policy event may already have run the next pass; either outcome is safe.
  if (!result.complete) {
    await expect(
      withReadyLintTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => true),
    ).rejects.toThrow("not ready");
  }
  expect((await coordinator.reconcile()).complete).toBe(true);
  expect(await readFile(join(f.root, "a/pyproject.toml"), "utf8")).toContain("101");
  expect(f.counts().resolves).toBe(1);
});

test("external native changes during a check cannot produce stale success", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  await expect(
    withReadyLintTarget(f.root, "python:a/pyproject.toml", { python: f.adapter }, async () => {
      await writeFile(join(f.root, "a/installed.json"), '{"ruff":"0.0.1"}');
      return true;
    }),
  ).rejects.toThrow("changed during the check");
});

test("new retain waits for the last owner's full teardown and receives a live coordinator", async () => {
  const f = await fixture();
  const entered = deferred(),
    finish = deferred();
  const resolve = f.adapter.resolve;
  f.adapter.resolve = async (...args) => {
    entered.resolve();
    await finish.promise;
    return resolve(...args);
  };
  const first = await retainLintCoordinator(f.root, { python: f.adapter });
  await entered.promise;
  const closing = first.release();
  let settled = false;
  const replacement = retainLintCoordinator(f.root, { python: f.adapter }).then((owner) => {
    settled = true;
    return owner;
  });
  try {
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  } finally {
    finish.resolve();
    await closing;
    const next = await replacement;
    try {
      expect(next.coordinator).not.toBe(first.coordinator);
      expect((await next.coordinator.reconcile()).complete).toBe(true);
      const peer = await retainLintCoordinator(f.root, { python: f.adapter });
      try {
        expect(peer.coordinator).toBe(next.coordinator);
        await next.release();
        expect((await peer.coordinator.reconcile()).complete).toBe(true);
      } finally {
        await peer.release();
      }
    } finally {
      await next.release();
    }
  }
});

test("failed config watcher setup releases its packaging retention and subscription", async () => {
  const f = await fixture();
  const root = await realpath(f.root);
  const originalAdd = FSWatcher.prototype.add;
  const add = spyOn(FSWatcher.prototype, "add").mockImplementation(function (this: FSWatcher, paths) {
    if (paths === join(root, ".justomp/config.json")) {
      throw new Error("injected config watcher failure");
    }
    return originalAdd.call(this, paths);
  });
  try {
    await expect(f.start()).rejects.toThrow("injected config watcher failure");
  } finally {
    add.mockRestore();
  }
  const registry = Reflect.get(globalThis, Symbol.for("justomp.packaging.v1")) as {
    leases: Map<string, number>;
    listeners: Map<string, Set<() => void>>;
  };
  expect(registry.leases.has(root)).toBe(false);
  expect(registry.listeners.has(root)).toBe(false);
  const retried = await f.start();
  expect((await retried.reconcile()).complete).toBe(true);
});

test("owners of a stopped instance cannot keep its replacement alive or evict it", async () => {
  const f = await fixture();
  const first = await retainLintCoordinator(f.root, { python: f.adapter });
  const second = await retainLintCoordinator(f.root, { python: f.adapter });
  try {
    expect((await first.coordinator.reconcile()).complete).toBe(true);
    await first.coordinator.shutdown();
    const replacement = await retainLintCoordinator(f.root, {
      python: f.adapter,
    });
    try {
      expect((await replacement.coordinator.reconcile()).complete).toBe(true);
    } finally {
      await replacement.release();
    }
    expect(replacement.coordinator.isClosed).toBe(true);
    const reopened = await f.start();
    await first.release();
    await second.release();
    const peer = await retainLintCoordinator(f.root, { python: f.adapter });
    try {
      expect(peer.coordinator === reopened).toBe(true);
      expect((await peer.coordinator.reconcile()).complete).toBe(true);
    } finally {
      await peer.release();
    }
  } finally {
    await first.release();
    await second.release();
  }
});

test("cancelled source fixing observes final child writes before releasing dependency domains", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  await writeFile(join(f.root, "a/module.py"), "before\n");
  const selected = await target(f.root),
    controller = new AbortController();
  const entered = deferred();
  const marker = join(f.root, "fix-started");
  f.adapter.fix = async (context) => {
    const child = runProcess(
      process.execPath,
      [
        "-e",
        `const fs = require('fs'); process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(process.env.SOURCE, 'after termination\\n'); process.exit(0); }, 60)); fs.writeFileSync(process.env.SOURCE, 'during fix\\n'); fs.writeFileSync(process.env.STARTED, 'ready'); setInterval(() => {}, 1000);`,
      ],
      {
        cwd: context.target.scope.cwd,
        env: {
          ...process.env,
          SOURCE: join(f.root, "a/module.py"),
          STARTED: marker,
        },
        signal: context.signal,
      },
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(marker);
        entered.resolve();
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    return child;
  };
  const fix = pendingLintFix("python");
  const running = withReadyLintTarget(
    f.root,
    selected.project.project_id,
    { python: f.adapter },
    (context) => applyLintFix(context, f.adapter, fix),
    controller.signal,
  );
  const outcome = running.then(
    () => null,
    (error: unknown) => error,
  );
  await entered.promise;
  let writerStarted = false;
  const waiting = withDomains(selected.scope.domains, undefined, async () => {
    writerStarted = true;
    expect(await readFile(join(f.root, "a/module.py"), "utf8")).toBe("after termination\n");
    expect(fix.changed_files).toEqual(["a/module.py"]);
  });
  expect(writerStarted).toBe(false);
  controller.abort();
  expect(await outcome).toBeInstanceOf(Error);
  await waiting;
  expect(fix).toMatchObject({
    status: "cancelled",
    observation_complete: true,
  });
});
