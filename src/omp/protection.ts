import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { withDomains } from "../dependencies/queue";
import { getPackagingStructure } from "../packaging/get-structure";
import { runProtectedBash } from "../protection/bash";
import {
  canonicalProtectionPath,
  findProtectedPath,
  resolveProtectedPaths,
} from "../protection/paths";
import { protectedEditMetadata } from "./protected-edit-metadata";
import {
  extractProtectedToolTargets,
  normalizeProtectionTarget,
} from "./protected-targets";

function editMetadata(ctx: ExtensionContext) {
  const settings = findScopedSettings();
  return settings ? protectedEditMetadata(settings, ctx.model) : undefined;
}

const fileTools = new Set(["write", "edit", "apply_patch"]);
async function withGeneralCall<T>(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  work: (root: string) => Promise<T>,
): Promise<T> {
  const root = await realpath(ctx.cwd);
  // Only general calls share this in-memory queue. Custom tool services stay unchanged.
  return withDomains([`justomp:general-files:${root}`], signal, () =>
    work(root),
  );
}
async function denyTargets(
  name: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
  root: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const mode = editMetadata(ctx)?.mode;
  const targets = extractProtectedToolTargets(name, input, mode);
  if (!targets) return;
  const { structure } = await getPackagingStructure(root, { signal });
  const protectedPaths = await resolveProtectedPaths(structure);
  for (const raw of targets) {
    const lexical = normalizeProtectionTarget(raw, ctx.cwd);
    const canonical = await canonicalProtectionPath(lexical);
    const denied =
      findProtectedPath(lexical, protectedPaths) ??
      findProtectedPath(canonical, protectedPaths);
    if (denied)
      throw new Error(
        `Justomp protected file: ${denied}. Use the relevant dependency/lint/typecheck custom tool, or edit it outside the agent.`,
      );
  }
  signal?.throwIfAborted();
  return mode;
}

/** Deny general file writes; custom tools and eval are deliberately outside this boundary. */
export function registerProtection(pi: ExtensionAPI): void {
  let lifetime = new AbortController();
  const wrapped = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  function track<T>(job: Promise<T>): Promise<T> {
    pending.add(job);
    void job.finally(() => pending.delete(job)).catch(() => undefined);
    return job;
  }
  const callSignal = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  pi.on("tool_call", (event) => {
    if (fileTools.has(event.toolName) && !wrapped.has(event.toolName))
      return {
        block: true,
        reason: `Justomp file protection is not ready for ${event.toolName}; no write was run.`,
      };
  });
  pi.on("session_start", (_event, ctx) => {
    lifetime = new AbortController();
    // Native schemas/descriptions are available only after the host binds its tool registry.
    // Headless hosts with no builtin registry may still use the Justomp custom tools.
    let tools: ReturnType<ExtensionAPI["getAllTools"]>;
    try {
      tools = pi.getAllTools();
    } catch {
      return;
    }
    const settings = findScopedSettings();
    const metadata = () =>
      settings ? protectedEditMetadata(settings, ctx.model) : undefined;
    for (const tool of tools) {
      if (!fileTools.has(tool.name) || wrapped.has(tool.name)) continue;
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        get description() {
          return tool.name === "edit"
            ? (metadata()?.description ?? tool.description)
            : tool.description;
        },
        get parameters() {
          return tool.name === "edit"
            ? (metadata()?.parameters ?? tool.parameters)
            : tool.parameters;
        },
        approval: "write",
        loadMode: "essential",
        async execute(_id, args, outerSignal, onUpdate, ctx) {
          const signal = callSignal(outerSignal);
          return track(
            withGeneralCall(ctx, signal, async (root) => {
              if (!ctx.invokeTool)
                throw new Error(
                  `Native ${tool.name} delegation is unavailable`,
                );
              const inspectedMode = await denyTargets(
                tool.name,
                args as Record<string, unknown>,
                ctx,
                root,
                signal,
              );
              if (
                tool.name === "edit" &&
                inspectedMode !== editMetadata(ctx)?.mode
              )
                throw new Error(
                  "Native edit mode changed during protection validation; retry the edit.",
                );
              return ctx.invokeTool(args as Record<string, unknown>, {
                signal,
                onUpdate,
              });
            }),
          );
        },
      });
      wrapped.add(tool.name);
    }
  });
  const schema = pi.zod.object({
    command: pi.zod
      .string()
      .describe("Bash command executed in a fresh protected-files sandbox."),
    cwd: pi.zod.string().optional(),
    timeout: pi.zod
      .number()
      .min(0)
      .optional()
      .describe("Seconds; default 300, zero disables the deadline."),
    async: pi.zod
      .boolean()
      .optional()
      .describe("Native async jobs are not supported; omit or set false."),
    pty: pi.zod
      .boolean()
      .optional()
      .describe("Native PTY is not supported; omit or set false."),
    name: pi.zod.string().optional(),
    ready: pi.zod.unknown().optional(),
  });
  pi.registerTool({
    name: "bash",
    label: "Protected bash",
    approval: "exec",
    loadMode: "essential",
    parameters: schema,
    description:
      "Run a foreground bash command in a fresh macOS/Linux sandbox. Source writes, reads and network access remain available; Justomp-managed manifests, locks and configs are write-denied. Output streams up to 128 KiB. Supports cwd, timeout and cancellation. Native async jobs, named services and PTY are not supported. Shell state does not persist between calls. Eval is not covered by this protection.",
    async execute(_id, input, outerSignal, onUpdate, ctx) {
      const args = schema.parse(input);
      if (
        args.async ||
        args.pty ||
        args.name?.trim() ||
        args.ready !== undefined
      )
        throw new Error(
          "Protected bash supports foreground commands only; native async jobs, named services and PTY are outside this version.",
        );
      const signal = callSignal(outerSignal);
      return track(
        withGeneralCall(ctx, signal, async (root) => {
          const cwd = args.cwd
            ? await realpath(resolve(ctx.cwd, args.cwd))
            : root;
          const { structure } = await getPackagingStructure(root, { signal });
          const paths = await resolveProtectedPaths(structure);
          let streamed = "";
          const result = await runProtectedBash({
            command: args.command,
            cwd,
            protectedPaths: paths,
            signal,
            timeoutMs:
              args.timeout === undefined ? undefined : args.timeout * 1000,
            onOutput: (chunk) => {
              streamed += chunk;
              onUpdate?.({
                content: [{ type: "text", text: streamed }],
                details: {},
              });
            },
          });
          const notice = result.cancelled
            ? "Command cancelled"
            : result.timedOut
              ? "Command timed out"
              : `Exit code: ${result.exitCode}`;
          return {
            content: [
              {
                type: "text",
                text: `${result.output}\n${notice}${result.truncated ? "\nOutput truncated at 128 KiB." : ""}`,
              },
            ],
            details: result,
            isError:
              result.exitCode !== 0 || result.cancelled || result.timedOut,
          };
        }),
      );
    },
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort(new Error("Protection session shut down"));
    await Promise.allSettled([...pending]);
  });
}
