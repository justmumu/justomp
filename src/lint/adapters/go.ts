import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../../dependencies/inventory";
import {
  type AdapterContext,
  type ProcessResult,
  redact,
} from "../../dependencies/model";
import { runProcess } from "../../dependencies/runner";
import { parseGo } from "../../inspect/readers/go";
import { readonlyGoEnvironment, withGoEnvironment } from "../go/environment";
import {
  golangciArtifact,
  installGolangci,
  latestGolangci,
  localGolangci,
} from "../go/install";
import { applyGoLintResult, applyGoReadiness } from "../go/result";
import { type LintCheck, LintError } from "../model";
import { projectGo } from "../projections/go";
import { lintManagerContext } from "../runtime";
import { collectLintScope } from "../scope";
import type { LintTarget } from "../targets";
import { stableVersion } from "../versions";
import type { LintAdapter } from "./types";

function successful(result: ProcessResult) {
  return result.exit_code === 0 && !result.truncated && !result.cancelled;
}
function assertSuccess(result: ProcessResult, message: string): void {
  if (!successful(result))
    throw new LintError(
      result.cancelled ? "cancelled" : "not-ready",
      redact(
        `${message}: ${result.stderr || result.stdout || `exit ${result.exit_code}`}${result.truncated ? " (truncated)" : ""}`,
      ),
    );
}
function goVersion(version: string): string {
  const raw = version.replace(/^go/, "");
  return stableVersion(raw.split(".").length === 2 ? `${raw}.0` : raw);
}
async function requiredGo(target: LintTarget): Promise<string> {
  const module = parseGo(
    await readFile(join(target.scope.cwd, "go.mod"), "utf8"),
    "mod",
  );
  let required = goVersion(module.go ?? "1.16");
  if (target.scope.env.GOWORK && target.scope.env.GOWORK !== "off") {
    const workspace = parseGo(
      await readFile(target.scope.env.GOWORK, "utf8"),
      "work",
    );
    const version = goVersion(workspace.go ?? "1.18");
    if (Bun.semver.order(version, required) > 0) required = version;
  }
  return required;
}
async function runtime(
  target: LintTarget,
  signal: AbortSignal,
): Promise<AdapterContext> {
  const native = await lintManagerContext(target, signal);
  const required = await requiredGo(target);
  if (Bun.semver.order(native.version, required) < 0)
    throw new LintError(
      "incompatible-toolchain",
      `Project/workspace requires Go ${required}, installed Go is ${native.version}; automatic toolchain download is disabled`,
    );
  return native;
}
async function binaryVersion(
  path: string,
  target: LintTarget,
  version: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await runProcess(path, ["version", "--json"], {
    cwd: target.scope.cwd,
    env: readonlyGoEnvironment(target),
    signal,
  });
  assertSuccess(result, "Go lint binary could not report its version");
  const data = object(JSON.parse(result.stdout));
  if (data.version !== version || typeof data.goVersion !== "string")
    throw new LintError(
      "version-mismatch",
      `Expected golangci-lint ${version} with a build Go version`,
    );
  const required = await requiredGo(target);
  if (Bun.semver.order(goVersion(data.goVersion), required) < 0)
    throw new LintError(
      "incompatible-toolchain",
      `golangci-lint built with ${data.goVersion} cannot analyze required Go ${required}`,
    );
}
export const goLintAdapter: LintAdapter = {
  async resolve(targets, _policy, signal, existing = {}) {
    const missing = targets.some(
      (target) => !existing[target.project.project_id]?.["golangci-lint"],
    );
    const latest = missing ? await latestGolangci(signal) : "";
    return Object.fromEntries(
      targets.map((target) => [
        target.project.project_id,
        {
          "golangci-lint": stableVersion(
            existing[target.project.project_id]?.["golangci-lint"] ?? latest,
          ),
        },
      ]),
    );
  },
  async preflight(context) {
    projectGo(context.policy.go);
    for (const target of context.targets) {
      golangciArtifact(
        stableVersion(
          context.versions[target.project.project_id]?.["golangci-lint"],
        ),
      );
      await runtime(target, context.signal);
    }
  },
  async prepareBatch(context) {
    for (const target of context.targets) {
      const version = stableVersion(
        context.versions[target.project.project_id]?.["golangci-lint"],
      );
      try {
        await binaryVersion(
          await localGolangci(target.root, version),
          target,
          version,
          context.signal,
        );
        continue;
      } catch {
        context.signal.throwIfAborted();
      }
      await installGolangci(
        target.root,
        version,
        target.project.project_id,
        context.signal,
        context.changes,
        (path) => binaryVersion(path, target, version, context.signal),
      );
    }
  },
  async verify(context) {
    try {
      projectGo(context.policy.go);
      await runtime(context.target, context.signal);
      const version = stableVersion(context.versions["golangci-lint"]);
      const path = await localGolangci(context.target.root, version);
      await binaryVersion(path, context.target, version, context.signal);
      const result = await runProcess(
        path,
        ["config", "verify", "--config", context.projection.configs.lint],
        {
          cwd: context.target.scope.cwd,
          env: readonlyGoEnvironment(context.target),
          signal: context.signal,
        },
      );
      return successful(result);
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  async check(context) {
    const scope = await collectLintScope(context.target);
    const checks: LintCheck[] = (["lint", "format"] as const).map((kind) => ({
      kind,
      status: scope.empty ? "no-sources" : "not-run",
      tool: "golangci-lint",
      version: context.versions["golangci-lint"] ?? null,
      exit_code: null,
      duration_ms: 0,
      diagnostics: [],
      truncated: false,
      cancelled: false,
    }));
    if (scope.empty) return checks;
    const start = performance.now();
    try {
      projectGo(context.policy.go);
      const native = await runtime(context.target, context.signal);
      const path = await localGolangci(
        context.target.root,
        stableVersion(context.versions["golangci-lint"]),
      );
      const result = await withGoEnvironment(
        context.target,
        native,
        async (env) => {
          const ready = await native.run({
            args: [
              "list",
              "-mod=readonly",
              "-deps",
              "-f",
              "{{if .Error}}{{.Error.Err}}{{end}}",
              ...scope.packages,
            ],
            label: "Verify selected Go package dependencies without downloads",
            env,
          });
          applyGoReadiness(checks, ready);
          return runProcess(
            path,
            [
              "run",
              "--config",
              context.projection.configs.lint,
              "--fix=false",
              "--modules-download-mode",
              "readonly",
              "--issues-exit-code",
              "1",
              "--allow-parallel-runners=false",
              "--allow-serial-runners=false",
              "--show-stats=false",
              "--",
              ...scope.packages,
            ],
            { cwd: context.target.scope.cwd, env, signal: context.signal },
          );
        },
      );
      applyGoLintResult(context, checks, result);
    } catch (error) {
      for (const check of checks) {
        check.reason = redact(
          error instanceof Error ? error.message : String(error),
        );
        check.cancelled = context.signal.aborted;
      }
    } finally {
      for (const check of checks) check.duration_ms = performance.now() - start;
    }
    return checks;
  },
};
