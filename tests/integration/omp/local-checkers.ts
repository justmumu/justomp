import { expect, spyOn } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type LintOperationContext } from "../../../src/lint/adapters/types";
import { lintAdapters } from "../../../src/lint/service";
import register from "../../../src/omp/extension";
import { pythonTestAdapter } from "../../../src/testing/python/adapter";
import { typecheckAdapters } from "../../../src/typecheck/service";
import { createHost } from "./host";

// Bind the real factory in the test module graph. The file-loader boundary has
// separate native proofs; its compatibility loader isolates module spies.
export function createLocalHost(root: string, deny: string[] = []) {
  return createHost(root, undefined, deny, register);
}

export async function assertLocalPreparation(root: string, tool: string) {
  expect(await Bun.file(join(root, ".justomp", `fixture-${tool}.json`)).exists()).toBe(true);
  expect(await Bun.file(join(root, "uv.lock")).exists()).toBe(false);
  expect(await Bun.file(join(root, ".venv", "pyvenv.cfg")).exists()).toBe(false);
}

type Target = LintOperationContext["targets"][number];
function receipt(target: Target, tool: string) {
  return join(target.scope.cwd, ".justomp", `fixture-${tool}.json`);
}
async function install(context: Pick<LintOperationContext, "targets" | "versions" | "changes">, tool: string) {
  for (const target of context.targets) {
    const path = receipt(target, tool);
    await mkdir(join(target.scope.cwd, ".justomp"), { recursive: true });
    await writeFile(path, JSON.stringify(context.versions[target.project.project_id]));
    context.changes.push({
      project_id: target.project.project_id,
      path: relative(target.root, path),
      kind: "updated",
    });
  }
}
async function verify(target: Target, versions: Record<string, string>, tool: string) {
  try {
    return (await readFile(receipt(target, tool), "utf8")) === JSON.stringify(versions);
  } catch {
    return false;
  }
}
/** Keep real host, watcher, projection and ownership behavior; supply local tool outcomes. */
export function localPythonCheckers() {
  const mocks = [
    spyOn(pythonTestAdapter, "resolve").mockResolvedValue({
      pytest: "9.0.2",
      "pytest-cov": "7.0.0",
    }),
    spyOn(pythonTestAdapter, "preflight").mockResolvedValue(undefined),
    spyOn(pythonTestAdapter, "verify").mockResolvedValue(true),
    spyOn(lintAdapters.python, "preflight").mockResolvedValue(undefined),
    spyOn(lintAdapters.python, "prepareBatch").mockImplementation((ctx) => install(ctx, "ruff")),
    spyOn(lintAdapters.python, "verify").mockImplementation((ctx) => verify(ctx.target, ctx.versions, "ruff")),
    spyOn(lintAdapters.python, "check").mockImplementation(async (ctx) => [
      {
        kind: "lint",
        status: "passed",
        tool: "ruff",
        version: ctx.versions.ruff ?? null,
        exit_code: 0,
        duration_ms: 0,
        diagnostics: [],
        truncated: false,
        cancelled: false,
      },
    ]),
    spyOn(typecheckAdapters.python, "preflight").mockResolvedValue(undefined),
    spyOn(typecheckAdapters.python, "prepareBatch").mockImplementation((ctx) => install(ctx, "pyright")),
    spyOn(typecheckAdapters.python, "verifyTools").mockImplementation((ctx) =>
      verify(ctx.target, ctx.versions, "pyright"),
    ),
    spyOn(typecheckAdapters.python, "check").mockImplementation(async (ctx) => [
      {
        status: "passed",
        tool: "pyright",
        version: ctx.versions.pyright ?? null,
        exit_code: 0,
        duration_ms: 0,
        diagnostics: [],
        truncated: false,
        cancelled: false,
      },
    ]),
  ];
  return () => {
    for (const mock of mocks.reverse()) {
      mock.mockRestore();
    }
  };
}
