import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TypecheckPolicy } from "../../config/typecheck/model";
import { object } from "../../dependencies/inventory";
import { type ProcessResult, redact } from "../../dependencies/model";
import { parseGo } from "../../inspect/readers/go";
import { withGoEnvironment } from "../../lint/go/environment";
import { lintManagerContext } from "../../lint/runtime";
import { assertGoSuccess, goCompileOutcome, recordGoProcess } from "../diagnostics/go";
import { type TypecheckCheck, TypecheckError } from "../model";
import { collectTypecheckScope } from "../scope";
import { type TypecheckTarget } from "../targets";
import { type TypecheckAdapter, type TypecheckCheckContext, type TypecheckToolContext } from "./types";

function tags(policy: TypecheckPolicy): string[] {
  if (Object.keys(policy.go).some((key) => key !== "build_tags")) {
    throw new TypecheckError("unsupported-config", "Go typecheck policy supports build_tags only");
  }
  if (
    !Array.isArray(policy.go.build_tags) ||
    !policy.go.build_tags.every((tag) => typeof tag === "string" && /^[\p{L}\p{N}_.]+$/u.test(tag))
  ) {
    throw new TypecheckError("invalid-config", "Go build_tags must contain individual native build tags");
  }
  return [...policy.go.build_tags];
}
async function runtime(target: TypecheckTarget, signal: AbortSignal) {
  signal.throwIfAborted();
  const native = await lintManagerContext(target, signal);
  const sources: [string, "mod" | "work"][] = [[join(target.scope.cwd, "go.mod"), "mod"]];
  if (target.scope.env.GOWORK && target.scope.env.GOWORK !== "off") {
    sources.push([target.scope.env.GOWORK, "work"]);
  }
  for (const [path, kind] of sources) {
    const version = parseGo(await readFile(path, "utf8"), kind).go ?? (kind === "mod" ? "1.16" : "1.18");
    const required = version.split(".").length === 2 ? `${version}.0` : version;
    if (Bun.semver.order(native.version, required) < 0) {
      throw new TypecheckError(
        "runtime-unavailable",
        `Project/workspace requires Go ${required}, installed Go is ${native.version}; install a compatible runtime explicitly (automatic toolchain download is disabled)`,
      );
    }
  }
  return native;
}
async function selectedRuntime(context: TypecheckToolContext) {
  tags(context.policy);
  const native = await runtime(context.target, context.signal);
  if (native.version !== context.versions.go) {
    throw new TypecheckError(
      "invalid-version",
      "Installed Go changed; run typecheck preparation to refresh its runtime receipt",
    );
  }
  return native;
}
export const goAdapter: TypecheckAdapter = {
  async resolve(targets, policy, signal) {
    tags(policy);
    const result: Record<string, { go: string }> = {};
    for (const target of targets) {
      result[target.project.project_id] = {
        go: (await runtime(target, signal)).version,
      };
    }
    return result;
  },
  async preflight(context) {
    for (const target of context.targets) {
      await selectedRuntime({
        ...context,
        target,
        versions: context.versions[target.project.project_id] ?? {},
      });
    }
  },
  async prepareBatch(context) {
    // Go already provides its compiler and standard library types; no installs.
    await this.preflight(context);
  },
  async verifyTools(context) {
    try {
      await selectedRuntime(context);
      return true;
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  async plan(target, policy, signal) {
    tags(policy);
    await runtime(target, signal);
    return { target, files: [], configs: { check: [] }, current: true };
  },
  async check(context) {
    const check: TypecheckCheck = {
      status: "not-run",
      tool: "go",
      version: context.versions.go ?? null,
      exit_code: null,
      duration_ms: 0,
      diagnostics: [],
      truncated: false,
      cancelled: false,
    };
    const start = performance.now();
    const record = (result: ProcessResult) => recordGoProcess(check, result);
    try {
      const buildTags = tags(context.policy),
        native = await selectedRuntime(context);
      const scope = await collectTypecheckScope(context.target);
      await withGoEnvironment(context.target, native, async (env) => {
        const platform = await native.run({
          args: ["env", "-json", "GOOS", "GOARCH"],
          env,
          label: "Read selected Go platform",
        });
        record(platform);
        assertGoSuccess(platform, "Go platform is unavailable");
        const values = object(JSON.parse(platform.stdout));
        if (typeof values.GOOS !== "string" || typeof values.GOARCH !== "string") {
          throw new Error("Go returned an invalid platform context");
        }
        check.context = {
          goos: values.GOOS,
          goarch: values.GOARCH,
          build_tags: buildTags,
        };
        const tagArgs = [`-tags=${buildTags.join(",")}`];
        const packages = await discoverPackages(scope.packages, native, env, tagArgs, check);
        if (!packages.length) {
          check.status = "no-sources";
          check.exit_code = null;
          return;
        }
        const scratch = await mkdtemp(join(tmpdir(), "justomp-go-typecheck-"));
        try {
          await compilePackages(packages, native, env, tagArgs, scratch, context, check);
        } finally {
          // The dependency runner waits for process close, including cancellation.
          await rm(scratch, { recursive: true, force: true });
        }
      });
    } catch (error) {
      check.status = "not-run";
      check.reason = redact(error instanceof Error ? error.message : String(error));
      check.cancelled ||= context.signal.aborted;
    } finally {
      check.duration_ms = performance.now() - start;
    }
    return [check];
  },
};

async function discoverPackages(
  directories: string[],
  native: Awaited<ReturnType<typeof selectedRuntime>>,
  env: Record<string, string>,
  tagArgs: string[],
  check: TypecheckCheck,
): Promise<string[]> {
  const record = (result: ProcessResult) => recordGoProcess(check, result);
  const packages: string[] = [];
  // Exact directories from the shared scope prevent Go's recursive loader
  // from seeing node_modules or independent child projects at all.
  for (const directory of directories) {
    const loaded = await native.run({
      args: ["list", "-e", "-json", ...tagArgs, directory],
      env,
      label: "Discover active scoped Go package",
    });
    record(loaded);
    assertGoSuccess(loaded, "Go package discovery failed; run dependency_sync if dependencies are missing");
    const pkg = object(JSON.parse(loaded.stdout));
    const active = ["GoFiles", "CgoFiles", "TestGoFiles", "XTestGoFiles"].some(
      (key) => Array.isArray(pkg[key]) && pkg[key].length > 0,
    );
    const loadError = object(pkg.Error).Err;
    if (
      !active &&
      typeof loadError === "string" &&
      /^(?:build constraints exclude all Go files|no Go files) in /.test(loadError)
    ) {
      continue;
    }
    if (!active && !loadError) {
      continue;
    }
    packages.push(directory);
  }
  return packages;
}

async function compilePackages(
  packages: string[],
  native: Awaited<ReturnType<typeof selectedRuntime>>,
  env: Record<string, string>,
  tagArgs: string[],
  scratch: string,
  context: TypecheckCheckContext,
  check: TypecheckCheck,
): Promise<void> {
  const record = (result: ProcessResult) => recordGoProcess(check, result);
  const statuses = new Set<ReturnType<typeof goCompileOutcome>["status"]>();
  for (const [index, directory] of packages.entries()) {
    const result = await native.run({
      args: ["test", "-c", "-vet=off", ...tagArgs, "-o", join(scratch, `${index}.test`), directory],
      env,
      label: "Compile Go source and tests without execution",
    });
    record(result);
    const outcome = goCompileOutcome(context, result);
    check.diagnostics.push(...outcome.diagnostics);
    statuses.add(outcome.status);
    if (outcome.status === "not-run") {
      if (outcome.reason !== undefined) {
        check.reason = outcome.reason;
      }
    }
    if (result.cancelled || result.truncated) {
      break;
    }
  }
  finishCompilation(check, statuses);
}

function finishCompilation(check: TypecheckCheck, statuses: Set<ReturnType<typeof goCompileOutcome>["status"]>): void {
  check.status = statuses.has("not-run") ? "not-run" : statuses.has("failed") ? "failed" : "passed";
  if (check.status === "failed") {
    check.exit_code = 1;
  }
}
