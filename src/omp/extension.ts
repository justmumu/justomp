import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/load";
import { retainLintCoordinator } from "../lint/coordinator";
import { lintAdapters } from "../lint/service";
import {
  getPackagingStructure,
  type PackagingResult,
  retainPackagingStructure,
  StructureError,
} from "../packaging/get-structure";
import { retainTestCoordinator } from "../testing/coordinator";
import { testAdapters } from "../testing/service";
import { retainTypecheckCoordinator } from "../typecheck/coordinator";
import { typecheckAdapters } from "../typecheck/service";
import { registerDependencyTools } from "./dependency-tools";
import { registerLintTools } from "./lint-tools";
import { registerTestTools } from "./test-tools";
import { registerTypecheckTools } from "./typecheck-tools";

interface Scope {
  root: string;
  controller: AbortController;
  release: () => Promise<void>;
  pending: Set<Promise<unknown>>;
  lint?: Promise<Awaited<ReturnType<typeof retainLintCoordinator>>>;
  unsubscribeLint?: () => void;
  typecheck?: Promise<Awaited<ReturnType<typeof retainTypecheckCoordinator>>>;
  unsubscribeTypecheck?: () => void;
  testing?: Promise<Awaited<ReturnType<typeof retainTestCoordinator>>>;
  unsubscribeTesting?: () => void;
}
function describeError(error: unknown) {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.name
        : "inspection-error";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && "partial" in error && error.partial
      ? { partial: error.partial }
      : {}),
  };
}
export default function registerInspection(pi: ExtensionAPI): void {
  let scope: Scope | undefined;
  let closed = false;
  let transition: Promise<void> = Promise.resolve();
  const pending = new Set<Promise<unknown>>();
  function track<T>(job: Promise<T>): Promise<T> {
    pending.add(job);
    void job.finally(() => pending.delete(job)).catch(() => undefined);
    return job;
  }
  async function releaseScope(active: Scope | undefined): Promise<void> {
    if (!active) return;
    // Release all owners before joining: either job may be waiting on the other's lease.
    const released = await Promise.allSettled([
      active.lint?.then(
        (owned) => owned.release(),
        () => undefined,
      ),
      active.testing?.then(
        (owned) => owned.release(),
        () => undefined,
      ),
      active.typecheck?.then(
        (owned) => owned.release(),
        () => undefined,
      ),
    ]);
    active.unsubscribeLint?.();
    active.unsubscribeTypecheck?.();
    active.unsubscribeTesting?.();
    await Promise.allSettled([...active.pending]);
    await active.release();
    const errors = released.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "Native preparation shutdown failed",
      );
  }

  async function lintCoordinator(root: string, ctx: ExtensionContext) {
    const active = scope;
    if (!active || active.root !== root || active.controller.signal.aborted)
      throw new StructureError(
        "root-changed",
        "Session root changed before lint preparation",
      );
    if (!active.lint) {
      active.lint = retainLintCoordinator(root, lintAdapters).then(
        async (owned) => {
          if (active.controller.signal.aborted) {
            await owned.release();
            throw active.controller.signal.reason;
          }
          const progress = owned.coordinator.subscribeProgress((value) =>
            reportPreparation(
              ctx,
              "lint",
              { root, preparation: value },
              "info",
            ),
          );
          const reports = owned.coordinator.subscribe((value) => {
            if (!value.complete || value.changes.length)
              reportPreparation(
                ctx,
                "lint",
                { root, preparation: value },
                value.complete ? "info" : "error",
              );
          });
          active.unsubscribeLint = () => {
            progress();
            reports();
          };
          return owned;
        },
      );
      void active.lint.catch(() => {
        if (!active.controller.signal.aborted) active.lint = undefined;
      });
    }
    return (await active.lint).coordinator;
  }
  async function typecheckCoordinator(root: string, ctx: ExtensionContext) {
    const active = scope;
    if (!active || active.root !== root || active.controller.signal.aborted)
      throw new StructureError(
        "root-changed",
        "Session root changed before typecheck preparation",
      );
    if (!active.typecheck) {
      active.typecheck = retainTypecheckCoordinator(
        root,
        typecheckAdapters,
      ).then(async (owned) => {
        if (active.controller.signal.aborted) {
          await owned.release();
          throw active.controller.signal.reason;
        }
        const progress = owned.coordinator.subscribeProgress((value) =>
          reportPreparation(
            ctx,
            "typecheck",
            { root, preparation: value },
            "info",
          ),
        );
        const reports = owned.coordinator.subscribe((value) => {
          const { projects: _projects, ...preparation } = value;
          if (!value.complete || value.changes.length)
            reportPreparation(
              ctx,
              "typecheck",
              { root, preparation },
              value.complete ? "info" : "error",
            );
        });
        active.unsubscribeTypecheck = () => {
          progress();
          reports();
        };
        return owned;
      });
      void active.typecheck.catch(() => {
        if (!active.controller.signal.aborted) active.typecheck = undefined;
      });
    }
    return (await active.typecheck).coordinator;
  }
  async function testCoordinator(root: string, ctx: ExtensionContext) {
    const active = scope;
    if (!active || active.root !== root || active.controller.signal.aborted)
      throw new StructureError(
        "root-changed",
        "Session root changed before test preparation",
      );
    if (!active.testing) {
      active.testing = retainTestCoordinator(root, testAdapters).then(
        async (owned) => {
          if (active.controller.signal.aborted) {
            await owned.release();
            throw active.controller.signal.reason;
          }
          const progress = owned.coordinator.subscribeProgress((value) =>
            reportPreparation(
              ctx,
              "test",
              { root, preparation: value },
              "info",
            ),
          );
          const reports = owned.coordinator.subscribe((value) => {
            if (!value.complete || value.changes.length)
              reportPreparation(
                ctx,
                "test",
                { root, preparation: value },
                value.complete ? "info" : "error",
              );
          });
          active.unsubscribeTesting = () => {
            progress();
            reports();
          };
          return owned;
        },
      );
      void active.testing.catch(() => {
        if (!active.controller.signal.aborted) active.testing = undefined;
      });
    }
    return (await active.testing).coordinator;
  }
  function selectRoot(root: string): Promise<Scope> {
    const next = transition.then(async () => {
      if (closed)
        throw new StructureError("closed", "Inspection session has shut down");
      const canonical = await realpath(root);
      if (closed)
        throw new StructureError("closed", "Inspection session has shut down");
      if (scope?.root === canonical) return scope;
      const previous = scope;
      scope = undefined;
      previous?.controller.abort(
        new StructureError("root-changed", "Session root changed"),
      );
      await releaseScope(previous);
      if (closed)
        throw new StructureError("closed", "Inspection session has shut down");
      const release = await retainPackagingStructure(canonical);
      if (closed) {
        await release();
        throw new StructureError("closed", "Inspection session has shut down");
      }
      scope = {
        root: canonical,
        controller: new AbortController(),
        release,
        pending: new Set(),
      };
      return scope;
    });
    transition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async function withRoot<T>(
    root: string,
    outerSignal: AbortSignal | undefined,
    work: (root: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    outerSignal?.throwIfAborted();
    const active = await selectRoot(root);
    const signal = AbortSignal.any([
      active.controller.signal,
      ...(outerSignal ? [outerSignal] : []),
    ]);
    signal.throwIfAborted();
    const job = work(active.root, signal);
    active.pending.add(job);
    try {
      return await job;
    } finally {
      active.pending.delete(job);
    }
  }
  registerDependencyTools(pi, (root, signal, work) =>
    track(withRoot(root, signal, work)),
  );
  registerLintTools(
    pi,
    (root, signal, work) => track(withRoot(root, signal, work)),
    lintCoordinator,
  );
  registerTypecheckTools(
    pi,
    (root, signal, work) => track(withRoot(root, signal, work)),
    typecheckCoordinator,
  );
  registerTestTools(
    pi,
    (root, signal, work) => track(withRoot(root, signal, work)),
    testCoordinator,
  );
  async function inspect(
    root: string,
    refresh: boolean,
    flush: boolean,
    outerSignal?: AbortSignal,
  ): Promise<PackagingResult> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new StructureError(
            "timeout",
            "Inspection exceeded the OMP handler budget",
          ),
        ),
      24_000,
    );
    try {
      return await withRoot(
        root,
        outerSignal,
        async (activeRoot, activeSignal) => {
          const signal = AbortSignal.any([deadline.signal, activeSignal]);
          signal.throwIfAborted();
          if (flush) await loadConfig(activeRoot, { flush: true, signal });
          return await getPackagingStructure(activeRoot, { refresh, signal });
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }
  const parameters = pi.zod.object({
    refresh: pi.zod
      .boolean()
      .optional()
      .describe(
        "Force a full inspection instead of reusing a clean watched snapshot.",
      ),
  });
  pi.registerTool({
    name: "project_inspect",
    label: "Inspect project packaging",
    description:
      "Inspect Python, JavaScript/TypeScript and Go manifests and workspace relationships in the current session directory. Reads project/config metadata and writes the derived .justomp/packaging_structure.json snapshot. Uses native watcher invalidation; refresh forces inspection. Does not run project code or package managers.",
    parameters,
    approval: "write",
    async execute(_callId, params, signal, _onUpdate, ctx) {
      try {
        const result = await track(
          inspect(
            ctx.cwd,
            parameters.parse(params).refresh ?? false,
            false,
            signal,
          ),
        );
        const mode = result.fallbackReason
          ? "full inspection (watcher unavailable)"
          : result.cacheHit
            ? "cached watched snapshot"
            : "refreshed snapshot";
        return {
          content: [
            {
              type: "text",
              text: `${result.structure.projects.length} projects, ${result.structure.workspaces.length} workspaces, ${result.structure.localDependencies.length} local dependencies; ${mode}.`,
            },
            { type: "text", text: JSON.stringify(result.structure) },
          ],
          details: result,
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const failure = describeError(error);
        return {
          content: [
            {
              type: "text",
              text: `Project inspection failed: ${failure.message}`,
            },
            { type: "text", text: JSON.stringify({ error: failure }) },
          ],
          details: { error: failure },
          isError: true,
        };
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    closed = false;
    try {
      const inspected = await track(inspect(ctx.cwd, false, true));
      // Native setup is tracked separately from the inspection handler's deadline.
      void track(
        withRoot(inspected.structure.root, undefined, async (root, signal) => {
          signal.throwIfAborted();
          const coordinators = await Promise.all([
            lintCoordinator(root, ctx),
            typecheckCoordinator(root, ctx),
            testCoordinator(root, ctx),
          ]);
          signal.throwIfAborted();
          // Coordinators own/join native jobs; a session only retains ownership.
          for (const coordinator of coordinators)
            void coordinator.reconcile().catch((error) => {
              if (!signal.aborted) reportStartupError(ctx, error);
            });
        }),
      ).catch((error) => {
        if (!closed) reportStartupError(ctx, error);
      });
    } catch (error) {
      reportStartupError(ctx, error);
    }
  });
  pi.on("session_shutdown", async () => {
    closed = true;
    scope?.controller.abort(
      new StructureError("closed", "Inspection session has shut down"),
    );
    await transition;
    scope?.controller.abort(
      new StructureError("closed", "Inspection session has shut down"),
    );
    const previous = scope;
    scope = undefined;
    await releaseScope(previous);
    await Promise.allSettled([...pending]);
  });
}
function reportStartupError(ctx: ExtensionContext, error: unknown): void {
  const message = `justomp: ${describeError(error).message}`;
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  else console.error(message);
}

function reportPreparation(
  ctx: ExtensionContext,
  kind: "lint" | "typecheck" | "test",
  value: object,
  level: "info" | "error",
): void {
  const message = `justomp ${kind}: ${JSON.stringify(value)}`;
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else if (level === "error") console.error(message);
  else console.info(message);
}
