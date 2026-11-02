import { afterEach, expect, spyOn, test } from "bun:test";
import { retainTestCoordinator, waitForTestPreparation } from "../../../src/testing/coordinator";
import { type TestPreparation } from "../../../src/testing/model";
import * as preparationModule from "../../../src/testing/prepare";
import { coordinatorPorts } from "./fixture";

function preparation(overrides: Partial<TestPreparation> = {}): TestPreparation {
  return {
    status: "ready",
    action: "already-ready",
    tools: {},
    affected_projects: [],
    changes: [],
    complete: true,
    cancelled: false,
    errors: [],
    ...overrides,
  };
}
function blockedPass() {
  return { started: Promise.withResolvers<void>(), result: Promise.withResolvers<TestPreparation>() };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
function fixture(run: typeof preparationModule.prepareTests) {
  const ports = coordinatorPorts();
  const spy = spyOn(preparationModule, "prepareTests").mockImplementation(run);
  cleanups.push(
    () => ports.restore(),
    () => spy.mockRestore(),
  );
  return { ...ports, spy };
}

test("test preparation coalesces changed inputs, isolates observer reports and detaches cancelled waiters", async () => {
  const first = blockedPass();
  const second = blockedPass();
  let calls = 0;
  let emit: ((report: TestPreparation) => void) | undefined;
  let sessionSignal: AbortSignal | undefined;
  const f = fixture((_root, _adapters, signal, progress) => {
    emit = progress;
    sessionSignal = signal;
    const pass = calls++ === 0 ? first : second;
    pass.started.resolve();
    return pass.result.promise;
  });
  const owned = await retainTestCoordinator("/coordinator", {});
  const peer = await retainTestCoordinator("/coordinator", {});
  cleanups.push(owned.release, peer.release);
  expect(peer.coordinator).toBe(owned.coordinator);
  const c = owned.coordinator;
  const progress: TestPreparation[] = [];
  const reports: TestPreparation[] = [];
  const stopMutating = c.subscribeProgress((report) => {
    report.errors.push({ code: "observer", message: "mutation" });
  });
  const stopProgress = c.subscribeProgress((report) => progress.push(report));
  const stopThrowing = c.subscribe(() => {
    throw new Error("observer failed");
  });
  const stopReports = c.subscribe((report) => reports.push(report));
  const caller = new AbortController();
  const cancelled = waitForTestPreparation(c, caller.signal);
  const survivor = waitForTestPreparation(c);
  expect(c.reconcile()).toBe(survivor);
  expect(c.preparing).toBe(true);
  await first.started.promise;
  caller.abort(new Error("caller left"));
  await expect(cancelled).rejects.toThrow("caller left");
  expect(sessionSignal?.aborted).toBe(false);
  emit?.(preparation({ status: "preparing", complete: false }));
  expect(progress[0]?.errors).toEqual([]);
  f.policy.testingKey = "updated";
  f.notify();
  f.notify();
  first.result.resolve(
    preparation({ action: "prepared", changes: [{ project_id: "python:a", path: "manifest", kind: "updated" }] }),
  );
  await second.started.promise;
  second.result.resolve(preparation());
  const result = await survivor;
  expect(calls).toBe(2);
  expect(result.action).toBe("prepared");
  expect(result.changes).toEqual([{ project_id: "python:a", path: "manifest", kind: "updated" }]);
  expect(reports).toEqual([result]);
  expect(reports[0]).not.toBe(result);
  expect(c.preparing).toBe(false);
  stopMutating();
  stopProgress();
  stopThrowing();
  stopReports();
  await owned.release();
  await owned.release();
  expect(c.isClosed).toBe(false);
  await peer.release();
  expect(c.isClosed).toBe(true);
  expect(sessionSignal?.aborted).toBe(true);
  expect(c.shutdown()).toBe(c.shutdown());
  f.notify();
  await expect(c.reconcile()).rejects.toThrow("closed");
  expect(f.events).toEqual(["retain:/coordinator", "unsubscribe:/coordinator", "release:/coordinator"]);
});

test("test preparation suppresses self-write reruns and reports a failed explicit retry", async () => {
  const f = fixture(() => {
    f.notify();
    return Promise.resolve(preparation());
  });
  const owned = await retainTestCoordinator("/coordinator", {});
  cleanups.push(owned.release);
  f.notify();
  expect((await owned.coordinator.reconcile()).complete).toBe(true);
  expect(f.spy).toHaveBeenCalledTimes(1);
  f.spy.mockRejectedValueOnce(new Error("runner preparation failed"));
  expect(await owned.coordinator.reconcile()).toMatchObject({
    status: "failed",
    complete: false,
    cancelled: false,
    errors: [{ code: "test-operation-failed", message: "runner preparation failed" }],
  });
  expect((await owned.coordinator.reconcile()).complete).toBe(true);
});
