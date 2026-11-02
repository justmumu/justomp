import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import * as config from "../../../src/config/load";
import { type LintCheckContext } from "../../../src/lint/adapters/types";
import * as coordinator from "../../../src/lint/coordinator";
import * as files from "../../../src/lint/files";
import { type PreparationReport } from "../../../src/lint/prepare";
import * as scopes from "../../../src/lint/scope";
import { checkLintTarget, fixLintTarget, lintAdapters } from "../../../src/lint/service";
import { suppliedResponse } from "../../response";
import { output, scope, target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture() {
  const selected = target("python"),
    controller = new AbortController();
  const policy = {
    lint: resolveLintConfig().policy,
    wrote: false,
  } as config.LoadedConfig;
  const context: LintCheckContext = {
    target: selected,
    policy: policy.lint,
    versions: { ruff: "0.17.3" },
    signal: controller.signal,
    projection: {
      target: selected,
      files: [],
      configs: { lint: "/repo/config", format: "/repo/config" },
      current: true,
    },
  };
  const report: PreparationReport = {
    status: "ready",
    action: "already-ready",
    tools: context.versions,
    affected_projects: [selected.project.project_id],
    changes: [],
    complete: true,
    cancelled: false,
    errors: [],
    projects: {},
  };
  report.projects[selected.project.project_id] = { ...report };
  keep(spyOn(config, "loadConfig").mockResolvedValue(policy));
  const lease = keep(
    spyOn(coordinator, "withReadyLintTarget").mockImplementation(async (_root, _id, _adapters, operation) =>
      operation(context),
    ),
  );
  keep(spyOn(scopes, "collectLintScope").mockResolvedValue(scope("module.py")));
  let changed = false;
  keep(
    spyOn(files, "readSourceFile").mockImplementation(async () => ({
      text: changed ? "after" : "before",
      identity: "1",
      mode: 0o644,
    })),
  );
  const fix = keep(
    spyOn(lintAdapters.python, "fix").mockImplementation(() => {
      return suppliedResponse(() => {
        changed = true;
        return output({ exit_code: 1 });
      });
    }),
  );
  const check = keep(
    spyOn(lintAdapters.python, "check").mockImplementation(async () =>
      (["lint", "format"] as const).map((kind) => ({
        kind,
        status: "passed",
        tool: "ruff",
        version: "0.17.3",
        exit_code: 0,
        duration_ms: 0,
        diagnostics: [],
        cancelled: false,
        truncated: false,
      })),
    ),
  );
  return {
    selected,
    controller,
    report,
    context,
    lease,
    fix,
    check,
    run: () => fixLintTarget(selected, controller.signal, report),
  };
}
test("fix and final checks share one ready lease, check-only never calls fixer", async () => {
  const f = fixture();
  f.check.mockImplementation(() => {
    return suppliedResponse(() => {
      expect(f.fix).toHaveBeenCalledTimes(1);
      return [
        {
          kind: "lint",
          status: "failed",
          tool: "ruff",
          version: "0.17.3",
          exit_code: 1,
          duration_ms: 0,
          diagnostics: [{ kind: "lint", severity: "error", message: "Remaining" }],
          cancelled: false,
          truncated: false,
        },
      ];
    });
  });
  expect(await f.run()).toMatchObject({
    complete: true,
    success: false,
    fix: { changed_files: ["apps/app/module.py"] },
    diagnostics: [{ message: "Remaining" }],
  });
  expect(f.lease).toHaveBeenCalledTimes(1);
  const checked = await checkLintTarget(f.selected, f.controller.signal, f.report);
  expect(checked).not.toHaveProperty("fix");
  expect(f.fix).toHaveBeenCalledTimes(1);
});
test("post-verification failure retains completed fix and checks", async () => {
  const f = fixture();
  f.lease.mockImplementation(async (_root, _id, _adapters, operation) => {
    await operation(f.context);
    throw new Error("Environment changed");
  });
  expect(await f.run()).toMatchObject({
    complete: false,
    partial_change: true,
    fix: { status: "completed", changed_files: ["apps/app/module.py"] },
    checks: [{ status: "passed" }, { status: "passed" }],
  });
});
test("failed preparation cannot start a fixer even if environment is otherwise ready", async () => {
  const f = fixture();
  const project = f.report.projects[f.selected.project.project_id];
  if (!project) {
    throw new Error("Missing fixture project");
  }
  project.complete = false;
  expect(await f.run()).toMatchObject({
    complete: false,
    fix: { status: "not-run" },
  });
  expect(f.fix).not.toHaveBeenCalled();
});
test("native operational failure skips final checks and preserves source effects", async () => {
  const f = fixture();
  f.fix.mockResolvedValue(output({ exit_code: 2 }));
  const result = await f.run();
  expect(result).toMatchObject({
    complete: false,
    fix: { status: "failed", errors: [{ code: "fix-failed" }] },
  });
  expect(f.check).not.toHaveBeenCalled();
});
test("cancellation before preparation retains a requested not-started fix", async () => {
  const f = fixture();
  f.controller.abort();
  expect(await f.run()).toMatchObject({
    cancelled: true,
    complete: false,
    fix: { requested: true, status: "cancelled", changed_files: [] },
  });
  expect(f.fix).not.toHaveBeenCalled();
});

test("check-only adapter failure preserves preparation failure reporting", async () => {
  const f = fixture();
  f.check.mockRejectedValue(new Error("Check launch failed"));
  expect(await checkLintTarget(f.selected, f.controller.signal, f.report)).toMatchObject({
    complete: false,
    incomplete_stages: ["preparation", "lint", "format"],
    preparation: { errors: [{ message: "Check launch failed" }] },
  });
  expect(f.fix).not.toHaveBeenCalled();
});
