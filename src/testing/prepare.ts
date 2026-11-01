import { join } from "node:path";
import { loadConfig } from "../config/load";
import { redact } from "../dependencies/model";
import { withDomains } from "../dependencies/queue";
import { getPackagingStructure } from "../packaging/get-structure";
import type { TestAdapters } from "./adapters";
import {
  TestError,
  type TestIssue,
  type TestPreparation,
  type TestRunner,
} from "./model";
import { testingPolicyKey } from "./policy";
import { nextWave, TestStateStore } from "./state";
import { resolveTestTarget, type TestTarget } from "./targets";
export function testIssue(error: unknown, project_id?: string): TestIssue {
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "test-operation-failed";
  return {
    code,
    message: redact(error instanceof Error ? error.message : String(error)),
    ...(project_id ? { project_id } : {}),
  };
}
export function preparationReport(): TestPreparation {
  return {
    status: "ready",
    action: "already-ready",
    tools: {},
    affected_projects: [],
    changes: [],
    complete: true,
    cancelled: false,
    errors: [],
  };
}
export function testDomains(root: string, targets: TestTarget[]): string[] {
  return [
    ...new Set([
      join(root, ".justomp/test_state.json"),
      ...targets.flatMap((t) => t.scope.domains),
    ]),
  ].sort();
}
export async function prepareTests(
  root: string,
  adapters: TestAdapters,
  signal: AbortSignal,
  onProgress?: (value: TestPreparation) => void,
): Promise<TestPreparation> {
  const report = preparationReport();
  try {
    const first = await getPackagingStructure(root, {
      signal,
      refresh: true,
      publish: false,
    });
    const initial: TestTarget[] = [];
    for (const project of first.structure.projects)
      try {
        initial.push(
          await resolveTestTarget(first.structure, project.project_id),
        );
      } catch (error) {
        report.errors.push(testIssue(error, project.project_id));
      }
    const domains = testDomains(first.structure.root, initial);
    await withDomains(domains, signal, async () => {
      const { structure } = await getPackagingStructure(root, {
        signal,
        refresh: true,
        publish: false,
      });
      const config = await loadConfig(structure.root, { signal, flush: true });
      const targets: TestTarget[] = [];
      for (const before of initial)
        targets.push(
          await resolveTestTarget(structure, before.project.project_id),
        );
      if (
        JSON.stringify(testDomains(structure.root, targets)) !==
          JSON.stringify(domains) ||
        structure.projects.some(
          (p) =>
            !first.structure.projects.some(
              (old) => old.project_id === p.project_id,
            ),
        )
      )
        throw new TestError(
          "scope-changed",
          "Project ownership changed while preparation waited; reconcile again",
        );
      const store = await TestStateStore.load(structure.root);
      const live = new Set(
        structure.projects.map((project) => project.project_id),
      );
      for (const [id, receipt] of Object.entries(store.state.projects)) {
        const target = targets.find(
          (candidate) => candidate.project.project_id === id,
        );
        if (!live.has(id) || (target && target.runner !== receipt.runner))
          delete store.state.projects[id];
      }
      for (const [runner, wave] of Object.entries(store.state.waves)) {
        wave.projects = wave.projects.filter(
          (id) =>
            live.has(id) &&
            !targets.some(
              (target) =>
                target.project.project_id === id && target.runner !== runner,
            ),
        );
        wave.pending = [];
        if (!wave.projects.length)
          delete store.state.waves[runner as TestRunner];
      }
      await store.save();
      for (const runner of ["pytest", "vitest", "bun", "go"] as TestRunner[]) {
        const members = targets.filter((t) => t.runner === runner);
        const ecosystem =
          runner === "pytest"
            ? "python"
            : runner === "go"
              ? "go"
              : "javascript";
        const unresolved = structure.projects.some(
          (project) =>
            project.ecosystem === ecosystem &&
            !targets.some(
              (target) => target.project.project_id === project.project_id,
            ),
        );
        if (unresolved) {
          const wave = store.state.waves[runner];
          if (wave) wave.complete = false;
          await store.save();
          continue;
        }
        if (!members.length) continue;
        const adapter = adapters[runner];
        if (!adapter) {
          report.errors.push({
            code: "unsupported-runner",
            message: `No ${runner} adapter registered`,
          });
          continue;
        }
        try {
          // Built-in runtime versions are receipts, not upgrade waves.
          if (runner === "bun" || runner === "go") {
            for (const target of members) {
              const tools = await adapter.resolve([target], signal);
              const ctx = { target, tools, signal };
              await adapter.preflight(ctx);
              if (!(await adapter.verify(ctx)))
                throw new TestError(
                  "runtime-unavailable",
                  `${runner} runtime is unavailable`,
                );
              store.state.projects[target.project.project_id] = {
                runner,
                tools,
                policy_hash: testingPolicyKey(config, target.project.ecosystem),
                ready: true,
              };
              report.tools[target.project.project_id] = tools;
            }
            await store.save();
            continue;
          }
          signal.throwIfAborted();
          const previous = store.state.waves[runner];
          const decision = nextWave(
            previous,
            members.map((t) => t.project.project_id),
          );
          const tools = decision.resolve
            ? await adapter.resolve(members, signal)
            : previous?.tools;
          if (!tools)
            throw new TestError("invalid-version", "Missing wave target");
          const wave = {
            projects: decision.projects,
            pending: decision.pending,
            tools,
            complete: false,
          };
          store.state.waves[runner] = wave;
          await store.save(); // exact target survives preflight/install failure
          const ready = new Map<string, boolean>();
          for (const target of members)
            ready.set(
              target.project.project_id,
              await adapter.verify({ target, tools, signal }),
            );
          // Only installation needs registry preflight; verified restarts stay local.
          // Every needed preflight still completes before the first mutation.
          for (const target of members)
            if (!ready.get(target.project.project_id))
              await adapter.preflight({ target, tools, signal });
          for (const target of members) {
            const id = target.project.project_id,
              ctx = { target, tools, signal };
            report.tools[id] = tools;
            store.state.projects[id] = {
              runner,
              tools,
              policy_hash: testingPolicyKey(config, target.project.ecosystem),
              ready: false,
            };
            await store.save();
            if (!ready.get(id)) {
              report.status = "preparing";
              report.action = "prepared";
              report.affected_projects.push(
                ...structure.projects
                  .filter(
                    (project) =>
                      project.managerRoot === target.project.managerRoot &&
                      project.manager === target.project.manager,
                  )
                  .map((project) => project.project_id),
              );
              onProgress?.(structuredClone(report));
              await adapter.prepare(ctx, report.changes);
              if (!(await adapter.verify(ctx)))
                throw new TestError(
                  "not-ready",
                  `Prepared ${id} does not match the selected runner tools`,
                );
            }
            store.state.projects[id].ready = true;
            await store.save();
          }
          wave.complete = true;
          await store.save();
        } catch (error) {
          report.errors.push(testIssue(error));
        }
      }
    });
  } catch (error) {
    report.errors.push(testIssue(error));
  }
  report.cancelled = signal.aborted;
  report.complete = !report.cancelled && !report.errors.length;
  report.status = report.complete ? "ready" : "failed";
  report.affected_projects = [
    ...new Set([
      ...report.affected_projects,
      ...report.changes.map((c) => c.project_id),
    ]),
  ];
  return report;
}
