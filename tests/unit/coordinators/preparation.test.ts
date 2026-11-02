import { afterEach, expect, spyOn, test } from "bun:test";
import { LintSession, retainLintCoordinator } from "../../../src/lint/coordinator";
import * as lintPreparation from "../../../src/lint/prepare";
import { retainTypecheckCoordinator, TypecheckSession } from "../../../src/typecheck/coordinator";
import * as typecheckPreparation from "../../../src/typecheck/prepare";
import { blockedPass, coordinatorPorts, preparation } from "./fixture";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function ports() {
  const value = coordinatorPorts();
  cleanups.push(() => value.restore());
  return value;
}

const kinds = [
  { name: "lint", retain: retainLintCoordinator, Session: LintSession },
  { name: "typecheck", retain: retainTypecheckCoordinator, Session: TypecheckSession },
] as const;

function preparationSpy(
  kind: (typeof kinds)[number],
  run: (
    root: string,
    adapters: unknown,
    signal: AbortSignal,
    progress?: (value: typecheckPreparation.PreparationProgress) => void,
  ) => Promise<typecheckPreparation.PreparationReport>,
) {
  const spy =
    kind.name === "lint"
      ? spyOn(lintPreparation, "prepareLint").mockImplementation(run)
      : spyOn(typecheckPreparation, "prepareTypecheck").mockImplementation(run);
  cleanups.push(() => spy.mockRestore());
  return spy;
}

for (const kind of kinds) {
  test(`${kind.name} coalesces packaging events and publishes accumulated effects with progress`, async () => {
    const f = ports();
    const first = blockedPass();
    const next = blockedPass();
    let calls = 0;
    let reportProgress: ((p: typecheckPreparation.PreparationProgress) => void) | undefined;
    preparationSpy(kind, (_root, _adapters, _signal, progress) => {
      reportProgress = progress;
      const pass = calls++ === 0 ? first : next;
      pass.started.resolve();
      return pass.result.promise;
    });
    const owned = await kind.retain("/coordinator", {});
    cleanups.push(owned.release);
    const c = owned.coordinator;
    await first.started.promise;
    const job = c.reconcile();
    expect(c.reconcile()).toBe(job);
    expect(c.preparing).toBe(true);
    const progress = { ecosystem: "python", affected_projects: ["python:a"], message: "Installing" } as const;
    const observed: unknown[] = [];
    const unsubscribeProgress = c.subscribeProgress(() => {
      throw new Error("observer failed");
    });
    reportProgress?.({ ...progress, affected_projects: [...progress.affected_projects] });
    const unsubscribeReplay = c.subscribeProgress((value) => observed.push(value));
    expect(observed).toEqual([progress]);
    const reports: unknown[] = [];
    const unsubscribe = c.subscribe((value) => reports.push(value));
    c.subscribe(() => {
      throw new Error("observer failed");
    });
    f.notify();
    f.notify();
    first.result.resolve(
      preparation({
        action: "prepared",
        recovery: "Recovered receipt",
        changes: [{ project_id: "python:a", path: "a/config", kind: "created" }],
      }),
    );
    await next.started.promise;
    next.result.resolve(
      preparation({
        changes: [{ project_id: "python:b", path: "b/config", kind: "updated" }],
        projects: { "python:a": preparation(), "python:b": preparation() },
      }),
    );
    const result = await job;
    expect(calls).toBe(2);
    expect(result.action).toBe("prepared");
    expect(result.recovery).toBe("Recovered receipt");
    expect(result.changes).toHaveLength(2);
    expect(result.projects["python:a"]?.changes).toEqual(result.changes.slice(0, 1));
    expect(result.projects["python:b"]?.changes).toEqual(result.changes.slice(1));
    expect(reports).toEqual([result]);
    expect(c.preparing).toBe(false);
    const replay: unknown[] = [];
    const unsubscribeReport = c.subscribe((value) => replay.push(value));
    expect(replay).toEqual([result]);
    unsubscribe();
    unsubscribeProgress();
    unsubscribeReplay();
    unsubscribeReport();
    await owned.release();
    expect(f.events.slice(-3)).toEqual(["unsubscribe:/coordinator", "watcher:close", "release:/coordinator"]);
    expect(c.shutdown()).toBe(c.shutdown());
    f.notify();
    await expect(c.reconcile()).rejects.toThrow("closed");
  });

  test(`${kind.name} failed self-write stops while changed input and explicit retry recover`, async () => {
    const f = ports();
    let calls = 0;
    const spy = preparationSpy(kind, () => {
      calls++;
      f.notify();
      return Promise.resolve(preparation({ status: "failed", complete: false }));
    });
    const owned = await kind.retain("/coordinator", {});
    cleanups.push(owned.release);
    expect((await owned.coordinator.reconcile()).complete).toBe(false);
    expect(calls).toBe(1);
    spy.mockImplementationOnce(() => {
      f.policy.lintKey = "changed";
      f.policy.typecheckKey = "changed";
      f.notify();
      return Promise.resolve(preparation({ status: "failed", complete: false }));
    });
    spy.mockImplementationOnce(() => Promise.resolve(preparation()));
    expect((await owned.coordinator.reconcile()).complete).toBe(true);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRejectedValueOnce(new Error("preparation unavailable"));
    expect(await owned.coordinator.reconcile()).toMatchObject({
      status: "failed",
      action: "not-attempted",
      complete: false,
      cancelled: false,
      errors: [{ code: "preparation-failed", message: "preparation unavailable" }],
    });
  });

  test(`${kind.name} root switching releases only its owner and shuts the final session down`, async () => {
    const f = ports();
    preparationSpy(kind, () => Promise.resolve(preparation()));
    const first = new kind.Session({});
    const second = new kind.Session({});
    cleanups.push(
      () => first.shutdown(),
      () => second.shutdown(),
    );
    const shared = await first.switchRoot("/first");
    await shared.reconcile();
    expect(await first.switchRoot("/first")).toBe(shared);
    expect(await second.switchRoot("/first")).toBe(shared);
    const replacement = await first.switchRoot("/second");
    await replacement.reconcile();
    expect(shared.isClosed).toBe(false);
    expect(replacement).not.toBe(shared);
    await second.shutdown();
    expect(shared.isClosed).toBe(true);
    expect(replacement.isClosed).toBe(false);
    await first.shutdown();
    expect(replacement.isClosed).toBe(true);
    expect(f.events.filter((event) => event.startsWith("release:"))).toEqual(["release:/first", "release:/second"]);
  });
}
