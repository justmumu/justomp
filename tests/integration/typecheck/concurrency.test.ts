import { expect, spyOn, test } from "bun:test";
import { access, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FSWatcher } from "chokidar";
import { withDomains } from "../../../src/dependencies/queue";
import { runProcess } from "../../../src/dependencies/runner";
import { getPackagingStructure } from "../../../src/packaging/get-structure";
import {
  retainTypecheckCoordinator,
  waitForTypecheckPreparation,
  withReadyTypecheckTarget,
} from "../../../src/typecheck/coordinator";
import { resolveTypecheckTarget } from "../../../src/typecheck/targets";
import { fixture } from "./fixture";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function target(root: string) {
  return resolveTypecheckTarget(
    (await getPackagingStructure(root)).structure,
    "python:a/pyproject.toml",
  );
}

test("check holds dependency domains and revalidates after waiting behind mutation", async () => {
  const f = await fixture();
  await f.add("b");
  const coordinator = await f.start();
  await coordinator.reconcile();
  const selected = await target(f.root);
  const entered = deferred(),
    release = deferred();
  let writerStarted = false;
  const check = withReadyTypecheckTarget(
    f.root,
    selected.project.project_id,
    { python: f.adapter },
    async () => {
      entered.resolve();
      await release.promise;
      return true;
    },
  );
  await entered.promise;
  const independent = await resolveTypecheckTarget(
    (await getPackagingStructure(f.root, { publish: false })).structure,
    "python:b/pyproject.toml",
  );
  expect(
    await withDomains(independent.scope.domains, undefined, async () => true),
  ).toBe(true);
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
    withReadyTypecheckTarget(
      f.root,
      selected.project.project_id,
      { python: f.adapter },
      async () => true,
    ),
  ).rejects.toThrow("not ready");
  const locked = deferred(),
    unlock = deferred();
  const mutation = withDomains(selected.scope.domains, undefined, async () => {
    locked.resolve();
    await unlock.promise;
  });
  await locked.promise;
  let ran = false;
  const waiting = withReadyTypecheckTarget(
    f.root,
    selected.project.project_id,
    { python: f.adapter },
    async () => {
      ran = true;
    },
  );
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

test("external native changes during a check cannot produce stale success", async () => {
  const f = await fixture();
  const coordinator = await f.start();
  await coordinator.reconcile();
  await expect(
    withReadyTypecheckTarget(
      f.root,
      "python:a/pyproject.toml",
      { python: f.adapter },
      async () => {
        await writeFile(
          join(f.root, "a/installed.json"),
          '{"pyright":"0.0.1"}',
        );
        return true;
      },
    ),
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
  const first = await retainTypecheckCoordinator(f.root, { python: f.adapter });
  await entered.promise;
  const closing = first.release();
  let settled = false;
  const replacement = retainTypecheckCoordinator(f.root, {
    python: f.adapter,
  }).then((owner) => {
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
      const peer = await retainTypecheckCoordinator(f.root, {
        python: f.adapter,
      });
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
  const add = spyOn(FSWatcher.prototype, "add").mockImplementation(function (
    this: FSWatcher,
    paths,
  ) {
    if (paths === join(root, ".justomp/config.json"))
      throw new Error("injected config watcher failure");
    return originalAdd.call(this, paths);
  });
  try {
    await expect(f.start()).rejects.toThrow("injected config watcher failure");
  } finally {
    add.mockRestore();
  }
  const registry = Reflect.get(
    globalThis,
    Symbol.for("justomp.packaging.v1"),
  ) as {
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
  const first = await retainTypecheckCoordinator(f.root, { python: f.adapter });
  const second = await retainTypecheckCoordinator(f.root, {
    python: f.adapter,
  });
  try {
    expect((await first.coordinator.reconcile()).complete).toBe(true);
    await first.coordinator.shutdown();
    const replacement = await retainTypecheckCoordinator(f.root, {
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
    const peer = await retainTypecheckCoordinator(f.root, {
      python: f.adapter,
    });
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

test("cancelling one preparation waiter leaves the shared native job and other waiter alive", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  const original = f.adapter.prepareBatch;
  f.adapter.prepareBatch = async (context) => {
    entered.resolve();
    await release.promise;
    await original(context);
  };
  const coordinator = await f.start();
  await entered.promise;
  const controller = new AbortController();
  const cancelled = waitForTypecheckPreparation(coordinator, controller.signal);
  const survivor = waitForTypecheckPreparation(coordinator);
  controller.abort(new Error("waiter cancelled"));
  await expect(cancelled).rejects.toThrow("waiter cancelled");
  release.resolve();
  expect((await survivor).complete).toBe(true);
  expect(f.counts()).toEqual({ resolves: 1, prepares: 1 });
});
