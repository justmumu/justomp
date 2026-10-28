import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../config/load";
import {
  getPackagingStructure,
  type PackagingResult,
  retainPackagingStructure,
  StructureError,
} from "../packaging/get-structure";

import { registerDependencyTools } from "./dependency-tools";

interface Scope {
  root: string;
  controller: AbortController;
  release: () => Promise<void>;
  pending: Set<Promise<unknown>>;
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
      await Promise.allSettled([...(previous?.pending ?? [])]);
      await previous?.release();
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
      await track(inspect(ctx.cwd, false, true));
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
    await Promise.allSettled([...pending]);
    const previous = scope;
    scope = undefined;
    await previous?.release();
  });
}
function reportStartupError(ctx: ExtensionContext, error: unknown): void {
  const message = `justomp: ${describeError(error).message}`;
  if (ctx.hasUI) ctx.ui.notify(message, "error");
  else console.error(message);
}
