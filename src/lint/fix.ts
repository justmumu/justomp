import { relative, resolve } from "node:path";
import { redact } from "../dependencies/model";
import { type LintAdapter, type LintCheckContext } from "./adapters/types";
import { readSourceFile } from "./files";
import { biomeDiagnostics } from "./javascript/result";
import { BIOME_PACKAGE } from "./javascript/tools";
import { type LintEcosystem, LintError, type LintFix } from "./model";
import { javascriptFrameworks } from "./projections/javascript";
import { collectLintScope, type LintScope } from "./scope";

export function pendingLintFix(ecosystem?: LintEcosystem): LintFix {
  return {
    requested: true,
    supported: ecosystem ? ecosystem !== "go" : null,
    status: "not-run",
    changed_files: [],
    observation_complete: true,
    errors: [],
  };
}
function assertSafePolicy(context: LintCheckContext, scope: LintScope): void {
  if (context.target.project.ecosystem === "javascript") {
    const policy = context.policy.javascript.biome;
    const { react, next } = javascriptFrameworks(context.target);
    const maps = [policy.rules, policy.test_rules];
    if (scope.hasTypescript) {
      maps.push(policy.typed_rules);
    }
    if (react) {
      maps.push(policy.react_rules);
    }
    if (next) {
      maps.push(policy.next_rules);
    }
    for (const map of maps) {
      for (const group of Object.values(map)) {
        for (const rule of Object.values(group)) {
          if (typeof rule === "object" && rule.fix === "safe") {
            throw new LintError(
              "unsupported-safe-fix-config",
              "Biome safe-only fixing cannot use rule fix: safe, which can promote unsafe actions. Remove that override to use fix, or run check-only; configuration was not changed.",
            );
          }
        }
      }
    }
    return;
  }
  if (context.target.project.ecosystem !== "python") {
    return;
  }
  const ruff = context.policy.python.ruff;
  const promotion = [ruff["extend-safe-fixes"], ruff.lint["extend-safe-fixes"]];
  if (
    Object.hasOwn(ruff, "extend") ||
    promotion.some((value) => value !== undefined && (!Array.isArray(value) || value.length !== 0))
  ) {
    throw new LintError(
      "unsupported-safe-fix-config",
      "Ruff safe-only fixing cannot use extend or nonempty/malformed extend-safe-fixes. Remove that override to use fix, or run check-only; configuration was not changed.",
    );
  }
}
/** Caller holds the ready lease; final check diagnostics are collected separately. */
export async function applyLintFix(context: LintCheckContext, adapter: LintAdapter, fix: LintFix): Promise<void> {
  context.signal.throwIfAborted();
  if (context.target.project.ecosystem === "go") {
    fix.status = "unsupported";
    fix.reason =
      "Go lint autofix is not supported; normal lint and format checks still run. Use project_format for formatting and imports.";
    return;
  }
  const scope = await collectLintScope(context.target, context.policy.javascript.exclude);
  if (scope.empty) {
    fix.reason = "no-sources";
    return;
  }
  assertSafePolicy(context, scope);
  if (!adapter.fix) {
    throw new LintError("unsupported-fix", "No native lint fixer is registered");
  }
  const snapshots = [];
  for (const file of scope.files) {
    context.signal.throwIfAborted();
    const path = resolve(context.target.scope.cwd, file);
    snapshots.push({
      path,
      before: await readSourceFile(context.target.scope.cwd, path),
    });
  }
  context.signal.throwIfAborted();
  fix.tool = context.target.project.ecosystem === "python" ? "ruff" : "biome";
  fix.version = context.versions[fix.tool === "biome" ? BIOME_PACKAGE : fix.tool] ?? null;
  fix.status = "failed";
  const started = performance.now();
  try {
    const result = await adapter.fix(context, scope.files);
    fix.exit_code = result.exit_code;
    fix.cancelled = result.cancelled || context.signal.aborted;
    fix.truncated = result.truncated;
    if (fix.cancelled) {
      fix.status = "cancelled";
      throw new LintError("cancelled", "Lint fix was cancelled");
    }
    if (result.truncated || (result.exit_code !== 0 && result.exit_code !== 1)) {
      throw new LintError(
        "fix-failed",
        redact(
          result.stderr ||
            `${fix.tool} fix did not complete (exit ${result.exit_code}${result.truncated ? ", output truncated" : ""})`,
        ),
      );
    }
    if (context.target.project.ecosystem === "javascript") {
      biomeDiagnostics(context, result, scope.files);
    }
    fix.status = "completed";
  } catch (error) {
    if (context.signal.aborted) {
      fix.status = "cancelled";
      fix.cancelled = true;
    }
    throw error;
  } finally {
    fix.duration_ms = performance.now() - started;
    // Do not reuse the operation signal: after process close, account for every path.
    for (const { path, before } of snapshots) {
      const relativePath = relative(context.target.root, path).replaceAll("\\", "/");
      try {
        const after = await readSourceFile(context.target.scope.cwd, path);
        if (after.text !== before.text || after.mode !== before.mode) {
          fix.changed_files.push(relativePath);
        }
      } catch (error) {
        fix.observation_complete = false;
        fix.errors.push({
          code: "observation-failed",
          path: relativePath,
          message: redact(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    fix.changed_files = [...new Set(fix.changed_files)].sort();
  }
  if (!fix.observation_complete) {
    throw new LintError("observation-incomplete", "Source observation was incomplete after lint fixing");
  }
}
