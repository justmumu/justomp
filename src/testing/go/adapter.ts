import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "../../dependencies/executable";
import { runProcess } from "../../dependencies/runner";
import { parseGo } from "../../inspect/readers/go";
import { withGoEnvironment } from "../../lint/go/environment";
import { lintManagerContext } from "../../lint/runtime";
import { type NativeTestResult, type TestAdapter, type TestToolContext } from "../adapters";
import { TestError, type TestSummary, unknownTests } from "../model";
import { coverageEnabled } from "../native-tools";
import { testIssue } from "../prepare";
import { type IntegrationConstraint, validateIntegrationConstraints } from "./constraints";
import { goCoverage } from "./coverage";
import { testGoFlags } from "./environment";
import { type GoPackage, type GoRunnable, parseGoPackages, selectGoTests } from "./inventory";
import { GoEvents } from "./reports";

async function runtime(context: Pick<TestToolContext, "target" | "signal">) {
  const native = await lintManagerContext(context.target, context.signal);
  if (Bun.semver.order(native.version, "1.22.0") < 0) {
    throw new TestError("runtime-unavailable", "Go testing requires Go 1.22+ for tests-less source coverage");
  }
  const files: [string, "mod" | "work"][] = [[join(context.target.scope.cwd, "go.mod"), "mod"]];
  const work = context.target.scope.env.GOWORK;
  if (work && work !== "off") {
    files.push([work, "work"]);
  }
  for (const [file, kind] of files) {
    const required = parseGo(await readFile(file, "utf8"), kind).go;
    if (
      required &&
      Bun.semver.order(native.version, required.split(".").length === 2 ? `${required}.0` : required) < 0
    ) {
      throw new TestError(
        "runtime-unavailable",
        `Project requires Go ${required}; install a compatible runtime explicitly`,
      );
    }
  }
  return native;
}
function combine(summaries: TestSummary[]): TestSummary {
  if (summaries.some((s) => s.total === null)) {
    return { ...unknownTests(), cases: summaries.flatMap((s) => s.cases) };
  }
  return {
    total: summaries.reduce((n, s) => n + (s.total ?? 0), 0),
    passed: summaries.reduce((n, s) => n + (s.passed ?? 0), 0),
    failed: summaries.reduce((n, s) => n + (s.failed ?? 0), 0),
    skipped: summaries.reduce((n, s) => n + (s.skipped ?? 0), 0),
    cases: summaries.flatMap((s) => s.cases),
  };
}
export const goTestAdapter: TestAdapter = {
  async resolve(targets, signal) {
    const target = targets[0];
    if (!target) {
      throw new TestError("project-not-found", "Missing Go target");
    }
    return { go: (await runtime({ target, signal })).version };
  },
  async preflight(context) {
    if ((await runtime(context)).version !== context.tools.go) {
      throw new TestError("runtime-conflict", "Installed Go version changed");
    }
  },
  async verify(context) {
    try {
      await this.preflight(context);
      return true;
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  async prepare() {},
  async run(context) {
    const result: NativeTestResult = {
        tests: unknownTests(),
        errors: [],
        executed_files: [],
        stdout: "",
        stderr: "",
        logs_truncated: false,
      },
      summaries: TestSummary[] = [],
      profiles: string[] = [],
      executedFiles = new Set<string>();
    const record = (process: Awaited<ReturnType<typeof runProcess>>) => {
      result.logs_truncated ||=
        result.stdout.length + process.stdout.length > 131072 || result.stderr.length + process.stderr.length > 131072;
      result.stdout = (result.stdout + process.stdout).slice(0, 131072);
      result.stderr = (result.stderr + process.stderr).slice(0, 131072);
      result.logs_truncated ||= process.truncated;
    };
    try {
      const native = await runtime(context),
        executable = await resolveExecutable(
          context.target.root,
          context.target.project,
          context.signal,
          context.target.scope,
        );
      const flags = testGoFlags(context.target.scope.env.GOFLAGS ?? "", context.suite);
      await withGoEnvironment(context.target, native, async (baseEnv) => {
        const env = { ...baseEnv, GOFLAGS: flags };
        const enabled = coverageEnabled(context);
        const directories = [
          ...new Set(
            [
              ...(context.mode === "targeted" ? context.scope.selected : context.scope.tests),
              ...(enabled ? context.scope.sources : []),
            ].map((file) => dirname(file)),
          ),
        ].sort();
        const packages: GoPackage[] = [];
        for (const directory of directories) {
          context.signal.throwIfAborted();
          const loaded = await runProcess(
            executable.command,
            ["list", "-e", "-json", directory === "." ? "." : `./${directory}`],
            { cwd: context.target.scope.cwd, env, signal: context.signal },
          );
          record(loaded);
          if (loaded.exit_code !== 0 || loaded.cancelled || loaded.truncated) {
            throw new TestError(
              "collection-failed",
              loaded.stderr || "Cannot collect Go packages; sync dependencies first",
            );
          }
          const data = JSON.parse(loaded.stdout) as GoPackage;
          if (data.Error && /^(?:build constraints exclude all Go files|no Go files) in /.test(data.Error.Err)) {
            continue;
          }
          packages.push(...parseGoPackages(loaded.stdout));
        }
        const activeTests = packages.flatMap((pkg) =>
          [...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? [])].map((file) =>
            relative(context.target.scope.cwd, join(pkg.Dir, file)).replaceAll("\\", "/"),
          ),
        );
        if (context.mode === "targeted") {
          for (const file of context.scope.selected) {
            if (!activeTests.includes(file)) {
              throw new TestError(
                "invalid-selection",
                `Selected Go file is inactive in this build environment: ${file}`,
              );
            }
          }
        }
        const inventoryFile = join(context.artifacts, "go-files.json");
        const constraintsFile = join(context.artifacts, "go-constraints.json");
        await writeFile(
          constraintsFile,
          JSON.stringify((context.scope.integration ?? []).map((file) => resolve(context.target.scope.cwd, file))),
        );
        await writeFile(
          inventoryFile,
          JSON.stringify(activeTests.map((file) => resolve(context.target.scope.cwd, file))),
        );
        const parsed = await runProcess(
          executable.command,
          ["run", fileURLToPath(new URL("./inventory.go", import.meta.url)), inventoryFile, constraintsFile],
          {
            cwd: context.target.scope.cwd,
            env: { ...env, GOWORK: "off" },
            signal: context.signal,
          },
        );
        record(parsed);
        if (parsed.exit_code !== 0 || parsed.cancelled || parsed.truncated) {
          throw new TestError("collection-failed", parsed.stderr || "Go test inventory failed");
        }
        const parsedInventory = JSON.parse(parsed.stdout) as {
          runnables: GoRunnable[];
          constraints: IntegrationConstraint[];
        };
        validateIntegrationConstraints(
          parsedInventory.constraints.map((entry) => ({
            ...entry,
            file: relative(context.target.scope.cwd, entry.file).replaceAll("\\", "/"),
          })),
        );
        const inventory = parsedInventory.runnables.map((r) => ({
          ...r,
          file: relative(context.target.scope.cwd, r.file).replaceAll("\\", "/"),
        }));
        const plans = packages.map((pkg) => {
          const files = [...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? [])].map((file) =>
              relative(context.target.scope.cwd, join(pkg.Dir, file)).replaceAll("\\", "/"),
            ),
            runnables = inventory.filter((r) => files.includes(r.file)),
            selected = files.filter((file) => context.scope.selected.includes(file));
          return {
            pkg,
            selected,
            runnables,
            ...selectGoTests(runnables, selected),
          };
        });
        if (!plans.some((plan) => plan.names.length)) {
          result.tests = {
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            cases: [],
          };
          return;
        }
        const paths = new Map<string, string>();
        for (const pkg of packages) {
          for (const file of [...(pkg.GoFiles ?? []), ...(pkg.CgoFiles ?? [])]) {
            const owned = relative(context.target.scope.cwd, join(pkg.Dir, file)).replaceAll("\\", "/");
            if (context.scope.sources.includes(owned)) {
              paths.set(`${pkg.ImportPath}/${file}`, owned);
              paths.set(join(pkg.Dir, file), owned);
            }
          }
        }
        const coverPackages = packages
          .filter((pkg) =>
            [...(pkg.GoFiles ?? []), ...(pkg.CgoFiles ?? [])].some((file) => paths.has(`${pkg.ImportPath}/${file}`)),
          )
          .map((pkg) => pkg.ImportPath);
        for (const [index, plan] of plans.entries()) {
          context.signal.throwIfAborted();
          if (!plan.names.length && !enabled) {
            continue;
          }
          const profile = join(context.artifacts, `go-${index}.cover`),
            events = new GoEvents(
              plan.pkg.ImportPath,
              plan.runnables.filter((r) => plan.selected.includes(r.file)),
            );
          const directory = relative(context.target.scope.cwd, plan.pkg.Dir),
            args = [
              "test",
              "-json",
              "-count=1",
              "-failfast=false",
              `-timeout=${Math.max(1, Math.floor(context.remainingMs()))}ms`,
              `-run=${plan.pattern}`,
              ...(enabled
                ? ["-covermode=atomic", `-coverpkg=${coverPackages.join(",")}`, `-coverprofile=${profile}`]
                : []),
              directory ? `./${directory}` : ".",
            ];
          const recorded = summaries.length;
          try {
            const process = await runProcess(executable.command, args, {
              cwd: context.target.scope.cwd,
              env,
              signal: context.signal,
              onStdout: (chunk) => events.write(chunk),
            });
            record(process);
            const observed = events.result();
            for (const file of observed.executed_files) {
              executedFiles.add(file);
            }
            summaries.push(observed.tests);
            result.errors.push(...observed.errors);
            if (process.cancelled) {
              throw new TestError("cancelled", "Go execution cancelled");
            }
            if (process.exit_code !== 0 && !observed.errors.length) {
              result.errors.push({
                code: "native-test-failed",
                message: process.stderr || `Go exited ${process.exit_code}`,
              });
            }
            if (enabled) {
              try {
                profiles.push(await readFile(profile, "utf8"));
              } catch (error) {
                result.errors.push(testIssue(error));
              }
            }
          } catch (error) {
            if (summaries.length === recorded) {
              const observed = events.result();
              summaries.push(observed.tests);
              for (const file of observed.executed_files) {
                executedFiles.add(file);
              }
            }
            throw error;
          }
          // A failed package does not prevent the next selected package from running.
        }
        result.tests = combine(summaries);
        if (enabled && !result.errors.some((e) => e.code !== "test-failed")) {
          result.coverage = goCoverage(profiles, paths);
        }
      });
    } catch (error) {
      result.errors.push(testIssue(error));
      if (summaries.length) {
        result.tests = {
          ...unknownTests(),
          cases: summaries.flatMap((s) => s.cases),
        };
      }
    }
    result.executed_files = [...executedFiles];
    return result;
  },
};
