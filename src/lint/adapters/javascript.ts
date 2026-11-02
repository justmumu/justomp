import { join, relative, resolve } from "node:path";
import { readOptional } from "../../dependencies/executable";
import { type DependencyRequest, redact } from "../../dependencies/model";
import { within } from "../../dependencies/paths";
import { checkPrettierFile, prettierVersion } from "../../format/engines/prettier";
import { formatterFor } from "../../format/selection";
import { nodeVersion, toolMetadata, validateCompatibility } from "../javascript/compatibility";
import { assertNative, installedPackages, localTool, nativeAdapter, succeeded } from "../javascript/native";
import { resolveJavascript } from "../javascript/resolve";
import { biomeDiagnostics } from "../javascript/result";
import { BIOME_PACKAGE, BIOME_TOOL, nativeJavascriptTools } from "../javascript/tools";
import { type LintCheck, LintError } from "../model";
import { lintManagerContext } from "../runtime";
import { collectLintScope } from "../scope";
import { type LintAdapter, type LintCheckContext, type LintOperationContext } from "./types";

async function operations(context: LintOperationContext) {
  return Promise.all(
    context.targets.map(async (target) => {
      const native = await lintManagerContext(target, context.signal);
      const adapter = nativeAdapter(native);
      const before = await adapter.inventory(native, false);
      const tools = nativeJavascriptTools(context.versions[target.project.project_id] ?? {});
      const requests: Exclude<DependencyRequest, { operation: "list" }>[] = [];
      const additions: Extract<DependencyRequest, { operation: "add" }>["packages"] = [];
      const updates: Extract<DependencyRequest, { operation: "update" }>["packages"] = [];
      for (const [name, version] of Object.entries(tools)) {
        const declarations = before.dependencies.filter((value) => value.name === name);
        if (
          declarations.some((value) => value.group.kind !== "dev" || value.source.kind !== "registry") ||
          declarations.length > 1
        ) {
          throw new LintError(
            "conflicting-declaration",
            `${name} must have one registry dev declaration; reconcile its existing groups/sources explicitly`,
          );
        }
        if (declarations.length) {
          updates.push({ name, version, group: { kind: "dev" } });
        } else {
          additions.push({ name, version, source: { kind: "registry" } });
        }
      }
      if (additions.length) {
        requests.push({
          operation: "add",
          project_id: target.project.project_id,
          packages: additions,
          group: { kind: "dev" },
        });
      }
      if (updates.length) {
        requests.push({
          operation: "update",
          project_id: target.project.project_id,
          packages: updates,
          mode: "within_constraints",
        });
      }
      const plans = await Promise.all(
        requests.map(async (request) => {
          const plan = await adapter.plan(native, request, before);
          if (request.operation === "add") {
            for (const step of plan.steps) {
              step.args.push(native.manager === "npm" || native.manager === "pnpm" ? "--save-exact" : "--exact");
            }
          }
          return { request, plan };
        }),
      );
      return { target, native, adapter, before, plans };
    }),
  );
}
function diagnosticPath(context: LintCheckContext, filename: string) {
  const absolute = resolve(context.target.scope.cwd, filename);
  if (!within(context.target.root, absolute) || !within(context.target.scope.cwd, absolute)) {
    return {};
  }
  return {
    path: relative(context.target.root, absolute).replaceAll("\\", "/"),
    project_path: relative(context.target.scope.cwd, absolute).replaceAll("\\", "/"),
  };
}
function biomeArgs(context: LintCheckContext, files: readonly string[], write = false): string[] {
  return [
    "check",
    `--config-path=${context.projection.configs.lint}`,
    "--formatter-enabled=false",
    "--linter-enabled=true",
    "--assist-enabled=true",
    "--enforce-assist=true",
    "--max-diagnostics=none",
    "--reporter=json",
    ...(write ? ["--write"] : []),
    "--",
    ...files.map((file) => `./${file}`),
  ];
}
export const javascriptAdapter: LintAdapter = {
  resolve: resolveJavascript,
  async preflight(context) {
    const all = await operations(context);
    for (const { target, native } of all) {
      try {
        const tools = nativeJavascriptTools(context.versions[target.project.project_id] ?? {});
        if (!tools[BIOME_PACKAGE]) {
          throw new LintError("missing-tool", `No resolved version for ${BIOME_PACKAGE}`);
        }
        const metadata = await toolMetadata(target, native, tools, context.signal);
        validateCompatibility(metadata, tools, await nodeVersion(target, native, context.signal));
      } catch (error) {
        if (error instanceof LintError) {
          throw new LintError(error.code, `${target.project.project_id}: ${error.message}`);
        }
        throw error;
      }
    }
  },
  async prepareBatch(context) {
    const all = await operations(context);
    const metadata = new Map<string, string>();
    for (const { target, plans } of all) {
      for (const { plan } of plans) {
        for (const path of plan.metadata) {
          metadata.set(join(target.root, path), target.project.project_id);
        }
      }
    }
    const before = new Map<string, string | null>();
    for (const path of metadata.keys()) {
      before.set(path, (await readOptional(path)) ?? null);
    }
    try {
      for (const { native, adapter, plans } of all) {
        for (const { request, plan } of plans) {
          const previous = await adapter.inventory(native, false);
          for (const step of plan.steps) {
            assertNative(await native.run(step), step.label);
          }
          await adapter.verify?.(native, request, previous, await adapter.inventory(native, false));
        }
      }
    } finally {
      for (const [path, project_id] of metadata) {
        const after = (await readOptional(path)) ?? null,
          previous = before.get(path);
        if (after !== previous) {
          context.changes.push({
            project_id,
            path: relative(context.targets[0]?.root ?? "", path).replaceAll("\\", "/"),
            kind: after === null ? "removed" : previous === null ? "created" : "updated",
          });
        }
      }
    }
  },
  async verify(context) {
    const tools = nativeJavascriptTools(context.versions);
    try {
      const native = await lintManagerContext(context.target, context.signal);
      const inventory = await nativeAdapter(native).inventory(native, false);
      if (!inventory.complete || inventory.diagnostics.length) {
        return false;
      }
      const installed = await installedPackages(context.target, native, Object.keys(tools), context.signal);
      for (const [name, version] of Object.entries(tools)) {
        const declarations = inventory.dependencies.filter((item) => item.name === name);
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
        ) {
          return false;
        }
      }
      validateCompatibility(installed, tools, await nodeVersion(context.target, native, context.signal));
      const result = await localTool(context.target, native, BIOME_TOOL, ["--version"], context.signal);
      return (
        succeeded(result) &&
        result.stdout.split("\n").some((line) => line.trim().replace(/^Version:\s*/, "") === tools[BIOME_PACKAGE])
      );
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  async fix(context, files) {
    const native = await lintManagerContext(context.target, context.signal);
    return localTool(context.target, native, BIOME_TOOL, biomeArgs(context, files, true), context.signal);
  },
  async check(context) {
    const scope = await collectLintScope(context.target, context.policy.javascript.exclude);
    const checks: LintCheck[] = [];
    for (const kind of ["lint", "format"] as const) {
      const tool = kind === "lint" ? "biome" : "prettier";
      const check: LintCheck = {
        kind,
        status: scope.empty ? "no-sources" : "not-run",
        tool,
        version: kind === "format" ? prettierVersion : (context.versions[BIOME_PACKAGE] ?? null),
        exit_code: null,
        duration_ms: 0,
        diagnostics: [],
        truncated: false,
        cancelled: false,
      };
      checks.push(check);
      if (scope.empty) {
        continue;
      }
      const start = performance.now();
      try {
        context.signal.throwIfAborted();
        if (kind === "format") {
          for (const file of scope.files) {
            context.signal.throwIfAborted();
            const formatter = formatterFor(file, "javascript");
            if (formatter?.engine !== "prettier") {
              throw new Error(`No bundled formatter for ${file}`);
            }
            if (
              !(await checkPrettierFile(
                join(context.target.scope.cwd, file),
                formatter.parser,
                context.policy.javascript.prettier,
              ))
            ) {
              check.diagnostics.push({
                kind,
                severity: "error",
                message: "File does not match the shared Prettier format",
                ...diagnosticPath(context, file),
              });
            }
          }
          context.signal.throwIfAborted();
          check.exit_code = check.diagnostics.length ? 1 : 0;
          check.status = check.diagnostics.length ? "failed" : "passed";
          continue;
        }
        const native = await lintManagerContext(context.target, context.signal);
        const result = await localTool(
          context.target,
          native,
          BIOME_TOOL,
          biomeArgs(context, scope.files),
          context.signal,
        );
        check.exit_code = result.exit_code;
        check.cancelled = result.cancelled;
        check.truncated = result.truncated;
        if (!result.cancelled && !result.truncated && (result.exit_code === 0 || result.exit_code === 1)) {
          check.diagnostics = biomeDiagnostics(context, result, scope.files);
          check.status = result.exit_code === 0 ? "passed" : "failed";
        } else {
          check.reason = redact(result.stderr || `${tool} did not complete (exit ${result.exit_code})`);
        }
      } catch (error) {
        check.reason = redact(error instanceof Error ? error.message : String(error));
        check.cancelled = context.signal.aborted;
      } finally {
        check.duration_ms = performance.now() - start;
      }
    }
    return checks;
  },
};
