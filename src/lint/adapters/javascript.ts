import { join, relative, resolve } from "node:path";
import { readOptional } from "../../dependencies/executable";
import { object } from "../../dependencies/inventory";
import type { DependencyRequest } from "../../dependencies/model";
import { redact } from "../../dependencies/model";
import { within } from "../../dependencies/paths";
import {
  applicationVersions,
  nodeVersion,
  toolMetadata,
  validateCompatibility,
} from "../javascript/compatibility";
import {
  assertNative,
  installedPackages,
  localTool,
  nativeAdapter,
  succeeded,
} from "../javascript/native";
import { resolveJavascript } from "../javascript/resolve";
import { requiredJavascriptTools } from "../javascript/tools";
import { type LintCheck, type LintDiagnostic, LintError } from "../model";
import { lintManagerContext } from "../runtime";
import { collectLintScope } from "../scope";
import type {
  LintAdapter,
  LintCheckContext,
  LintOperationContext,
} from "./types";

async function operations(context: LintOperationContext) {
  return Promise.all(
    context.targets.map(async (target) => {
      const native = await lintManagerContext(target, context.signal);
      const adapter = nativeAdapter(native);
      const before = await adapter.inventory(native, false);
      const tools = context.versions[target.project.project_id] ?? {};
      const requests: Exclude<DependencyRequest, { operation: "list" }>[] = [];
      const additions: Extract<
        DependencyRequest,
        { operation: "add" }
      >["packages"] = [];
      const updates: Extract<
        DependencyRequest,
        { operation: "update" }
      >["packages"] = [];
      for (const [name, version] of Object.entries(tools)) {
        const declarations = before.dependencies.filter(
          (value) => value.name === name,
        );
        if (
          declarations.some(
            (value) =>
              value.group.kind !== "dev" || value.source.kind !== "registry",
          ) ||
          declarations.length > 1
        )
          throw new LintError(
            "conflicting-declaration",
            `${name} must have one registry dev declaration; reconcile its existing groups/sources explicitly`,
          );
        if (declarations.length)
          updates.push({ name, version, group: { kind: "dev" } });
        else additions.push({ name, version, source: { kind: "registry" } });
      }
      if (additions.length)
        requests.push({
          operation: "add",
          project_id: target.project.project_id,
          packages: additions,
          group: { kind: "dev" },
        });
      if (updates.length)
        requests.push({
          operation: "update",
          project_id: target.project.project_id,
          packages: updates,
          mode: "within_constraints",
        });
      const plans = await Promise.all(
        requests.map(async (request) => {
          const plan = await adapter.plan(native, request, before);
          if (request.operation === "add")
            for (const step of plan.steps)
              step.args.push(
                native.manager === "npm" || native.manager === "pnpm"
                  ? "--save-exact"
                  : "--exact",
              );
          return { request, plan };
        }),
      );
      return { target, native, adapter, before, plans };
    }),
  );
}
function diagnosticPath(context: LintCheckContext, filename: string) {
  const absolute = resolve(context.target.scope.cwd, filename);
  if (
    !within(context.target.root, absolute) ||
    !within(context.target.scope.cwd, absolute)
  )
    return {};
  return {
    path: relative(context.target.root, absolute).replaceAll("\\", "/"),
    project_path: relative(context.target.scope.cwd, absolute).replaceAll(
      "\\",
      "/",
    ),
  };
}
function eslintDiagnostics(
  context: LintCheckContext,
  output: string,
): LintDiagnostic[] {
  const start = output.indexOf("[{");
  const end = output.lastIndexOf("]");
  const rows: unknown = JSON.parse(
    output.includes("[]") && start === -1 ? "[]" : output.slice(start, end + 1),
  );
  if (!Array.isArray(rows))
    throw new Error("ESLint returned invalid JSON diagnostics");
  return rows.flatMap((row) => {
    const item = object(row);
    if (typeof item.filePath !== "string" || !Array.isArray(item.messages))
      throw new Error("ESLint returned invalid JSON diagnostics");
    return item.messages.map((raw) => {
      const message = object(raw);
      if (typeof message.message !== "string")
        throw new Error("ESLint returned invalid JSON diagnostics");
      return {
        kind: "lint" as const,
        ...diagnosticPath(context, item.filePath as string),
        severity:
          message.severity === 1 ? ("warning" as const) : ("error" as const),
        message: redact(message.message),
        ...(typeof message.ruleId === "string" ? { rule: message.ruleId } : {}),
        ...(typeof message.line === "number" ? { line: message.line } : {}),
        ...(typeof message.column === "number"
          ? { column: message.column }
          : {}),
        ...(typeof message.endLine === "number"
          ? { end_line: message.endLine }
          : {}),
        ...(typeof message.endColumn === "number"
          ? { end_column: message.endColumn }
          : {}),
      };
    });
  });
}
export const javascriptAdapter: LintAdapter = {
  resolve: resolveJavascript,
  async preflight(context) {
    const all = await operations(context);
    for (const { target, native } of all) {
      const tools = context.versions[target.project.project_id] ?? {};
      for (const name of await requiredJavascriptTools(
        target,
        context.policy.javascript,
      ))
        if (!tools[name])
          throw new LintError(
            "missing-tool",
            `No resolved version for ${name}`,
          );
      const application = await applicationVersions(
        target,
        native,
        context.signal,
      );
      const metadata = await toolMetadata(
        target,
        native,
        tools,
        context.signal,
      );
      validateCompatibility(
        metadata,
        tools,
        application,
        await nodeVersion(target, native, context.signal),
      );
    }
  },
  async prepareBatch(context) {
    const all = await operations(context);
    const metadata = new Map<string, string>();
    for (const { target, plans } of all)
      for (const { plan } of plans)
        for (const path of plan.metadata)
          metadata.set(join(target.root, path), target.project.project_id);
    const before = new Map<string, string | null>();
    for (const path of metadata.keys())
      before.set(path, (await readOptional(path)) ?? null);
    try {
      for (const { native, adapter, plans } of all)
        for (const { request, plan } of plans) {
          const previous = await adapter.inventory(native, false);
          for (const step of plan.steps)
            assertNative(await native.run(step), step.label);
          await adapter.verify?.(
            native,
            request,
            previous,
            await adapter.inventory(native, false),
          );
        }
    } finally {
      for (const [path, project_id] of metadata) {
        const after = (await readOptional(path)) ?? null,
          previous = before.get(path);
        if (after !== previous)
          context.changes.push({
            project_id,
            path: relative(context.targets[0]?.root ?? "", path).replaceAll(
              "\\",
              "/",
            ),
            kind:
              after === null
                ? "removed"
                : previous === null
                  ? "created"
                  : "updated",
          });
      }
    }
  },
  async verify(context) {
    try {
      const native = await lintManagerContext(context.target, context.signal);
      const inventory = await nativeAdapter(native).inventory(native, false);
      if (!inventory.complete || inventory.diagnostics.length) return false;
      const installed = await installedPackages(
        context.target,
        native,
        Object.keys(context.versions),
        context.signal,
      );
      for (const [name, version] of Object.entries(context.versions)) {
        const declarations = inventory.dependencies.filter(
          (item) => item.name === name,
        );
        const item = declarations[0];
        if (
          declarations.length !== 1 ||
          !item ||
          item.group.kind !== "dev" ||
          item.source.kind !== "registry" ||
          item.declared_specifier !== version ||
          !item.resolutions?.length ||
          item.resolutions.some((value) => value.version !== version) ||
          installed[name]?.version !== version
        )
          return false;
      }
      validateCompatibility(
        installed,
        context.versions,
        await applicationVersions(context.target, native, context.signal, true),
        await nodeVersion(context.target, native, context.signal),
      );
      for (const name of ["eslint", "prettier"]) {
        const result = await localTool(
          context.target,
          native,
          { package: name, binary: name },
          ["--version"],
          context.signal,
        );
        if (
          !succeeded(result) ||
          !result.stdout
            .split("\n")
            .some((line) => line.replace(/^v/, "") === context.versions[name])
        )
          return false;
      }
      return true;
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  async check(context) {
    const scope = await collectLintScope(context.target);
    const checks: LintCheck[] = [];
    for (const kind of ["lint", "format"] as const) {
      const tool = kind === "lint" ? "eslint" : "prettier";
      const check: LintCheck = {
        kind,
        status: scope.empty ? "no-sources" : "not-run",
        tool,
        version: context.versions[tool] ?? null,
        exit_code: null,
        duration_ms: 0,
        diagnostics: [],
        truncated: false,
        cancelled: false,
      };
      checks.push(check);
      if (scope.empty) continue;
      const start = performance.now();
      try {
        const native = await lintManagerContext(context.target, context.signal);
        const args =
          kind === "lint"
            ? [
                "--no-config-lookup",
                "--no-fix",
                "--config",
                context.projection.configs.lint,
                "--format",
                join(import.meta.dir, "../javascript/formatter.cjs"),
              ]
            : [
                "--list-different",
                "--config",
                context.projection.configs.format,
                "--no-editorconfig",
                "--ignore-path",
                process.platform === "win32" ? "NUL" : "/dev/null",
              ];
        const result = await localTool(
          context.target,
          native,
          { package: tool, binary: tool },
          [...args, "--", ...scope.files.map((file) => `./${file}`)],
          context.signal,
        );
        check.exit_code = result.exit_code;
        check.cancelled = result.cancelled;
        check.truncated = result.truncated;
        if (
          !result.cancelled &&
          !result.truncated &&
          (result.exit_code === 0 || result.exit_code === 1)
        ) {
          check.diagnostics =
            kind === "lint"
              ? eslintDiagnostics(context, result.stdout)
              : result.stdout
                  .split("\n")
                  .map((line) => line.trim().replace(/^\.\//, ""))
                  .filter((line) => scope.files.includes(line))
                  .map((filename) => ({
                    kind,
                    severity: "error",
                    message: "File does not match the shared Prettier format",
                    ...diagnosticPath(context, filename),
                  }));
          if (
            kind === "format" &&
            result.exit_code === 1 &&
            check.diagnostics.length === 0
          )
            check.reason = redact(
              result.stderr ||
                "Prettier failed without reporting a source format difference",
            );
          else check.status = result.exit_code === 0 ? "passed" : "failed";
        } else
          check.reason = redact(
            result.stderr ||
              `${tool} did not complete (exit ${result.exit_code})`,
          );
      } catch (error) {
        check.reason = redact(
          error instanceof Error ? error.message : String(error),
        );
        check.cancelled = context.signal.aborted;
      } finally {
        check.duration_ms = performance.now() - start;
      }
    }
    return checks;
  },
};
