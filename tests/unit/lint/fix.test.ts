import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import type {
  LintAdapter,
  LintCheckContext,
} from "../../../src/lint/adapters/types";
import * as files from "../../../src/lint/files";
import { applyLintFix, pendingLintFix } from "../../../src/lint/fix";
import * as scopes from "../../../src/lint/scope";
import { output, scope, target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture(ecosystem: "python" | "javascript" | "go" = "python") {
  const selected = target(ecosystem),
    controller = new AbortController();
  const context: LintCheckContext = {
    target: selected,
    policy: resolveLintConfig().policy,
    versions: { ruff: "0.17.3", "@biomejs/biome": "2.6.3" },
    signal: controller.signal,
    projection: {
      target: selected,
      files: [],
      configs: { lint: "/repo/config", format: "/repo/config" },
      current: true,
    },
  };
  let after = false;
  const reads = keep(
    spyOn(files, "readSourceFile").mockImplementation(async (_root, path) => ({
      text: after && path.endsWith("module.py") ? "new" : "old",
      identity: "1:1",
      mode: 0o644,
    })),
  );
  const selectedFiles = keep(
    spyOn(scopes, "collectLintScope").mockResolvedValue(scope("module.py")),
  );
  const invoke = {
    async fix() {
      after = true;
      return output({ exit_code: 1 });
    },
  };
  const fix = keep(spyOn(invoke, "fix"));
  const adapter = invoke as unknown as LintAdapter;
  const report = pendingLintFix(ecosystem);
  return {
    context,
    controller,
    reads,
    selectedFiles,
    fix,
    adapter,
    report,
    run: () => applyLintFix(context, adapter, report),
  };
}
test("fix observes source changes after native exit 1 without parsing stale diagnostics", async () => {
  const f = fixture();
  await f.run();
  expect(f.report).toMatchObject({
    status: "completed",
    changed_files: ["apps/app/module.py"],
    exit_code: 1,
    observation_complete: true,
  });
  expect(f.fix).toHaveBeenCalledWith(f.context, ["module.py"]);
});
test("empty scope and Go never invoke a writer", async () => {
  const f = fixture();
  f.selectedFiles.mockResolvedValue({
    ...scope("unused"),
    files: [],
    empty: true,
  });
  await f.run();
  expect(f.report).toMatchObject({
    status: "not-run",
    reason: "no-sources",
    changed_files: [],
  });
  expect(f.fix).not.toHaveBeenCalled();
  const go = fixture("go");
  await go.run();
  expect(go.report).toMatchObject({
    supported: false,
    status: "unsupported",
    changed_files: [],
  });
  expect(go.fix).not.toHaveBeenCalled();
});
for (const policy of [
  { "extend-safe-fixes": ["ALL"] },
  { lint: { "extend-safe-fixes": ["F"] } },
  { extend: "../ruff.toml" },
  { lint: { "extend-safe-fixes": null } },
]) {
  test(`unsafe promotion or unresolved inheritance refuses writes: ${JSON.stringify(policy)}`, async () => {
    const f = fixture();
    Object.assign(f.context.policy.python.ruff, policy);
    await expect(f.run()).rejects.toThrow("safe-only");
    expect(f.fix).not.toHaveBeenCalled();
    expect(f.reads).not.toHaveBeenCalled();
  });
}
test("empty promotions and stricter fix eligibility remain usable", async () => {
  const f = fixture();
  Object.assign(f.context.policy.python.ruff.lint, {
    "extend-safe-fixes": [],
    "extend-unsafe-fixes": ["F401"],
    unfixable: ["F841"],
  });
  await f.run();
  expect(f.report.status).toBe("completed");
  expect(f.context.policy.python.ruff.lint.unfixable).toEqual(["F841"]);
});
test("before-read failure prevents all native writes", async () => {
  const f = fixture();
  f.reads.mockRejectedValue(new Error("Cannot read source"));
  await expect(f.run()).rejects.toThrow("Cannot read source");
  expect(f.fix).not.toHaveBeenCalled();
});
for (const outcome of [
  "failed",
  "cancelled",
  "truncated",
  "rejected",
] as const) {
  test(`native ${outcome} retains observed edits`, async () => {
    const cancelled = outcome === "cancelled";
    const f = fixture();
    let calls = 0;
    f.reads.mockImplementation(async () => ({
      text: calls++ ? "changed" : "old",
      identity: "1:1",
      mode: 0o644,
    }));
    f.fix.mockImplementation(async () => {
      if (cancelled) f.controller.abort();
      if (outcome === "rejected") throw new Error("Native launch failed");
      return output({
        exit_code: cancelled ? null : outcome === "truncated" ? 0 : 2,
        cancelled,
        truncated: outcome === "truncated",
      });
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.report).toMatchObject({
      status: cancelled ? "cancelled" : "failed",
      changed_files: ["apps/app/module.py"],
      observation_complete: true,
    });
    expect(f.reads).toHaveBeenCalledTimes(2);
  });
}
test("one failed after-read cannot erase changes to the remaining files", async () => {
  const f = fixture();
  f.selectedFiles.mockResolvedValue({
    ...scope("module.py"),
    files: ["bad.py", "module.py"],
  });
  let reads = 0;
  f.reads.mockImplementation(async (_root, path) => {
    if (++reads > 2 && path.endsWith("bad.py"))
      throw new Error("File disappeared");
    return {
      text: reads > 2 ? "changed" : "old",
      identity: "1:1",
      mode: 0o644,
    };
  });
  await expect(f.run()).rejects.toThrow("observation");
  expect(f.report).toMatchObject({
    status: "completed",
    observation_complete: false,
    changed_files: ["apps/app/module.py"],
    errors: [{ path: "apps/app/bad.py", code: "observation-failed" }],
  });
});

for (const key of [
  "rules",
  "typed_rules",
  "test_rules",
  "react_rules",
  "next_rules",
] as const) {
  test(`Biome ${key} cannot promote unsafe fixes`, async () => {
    const f = fixture("javascript");
    f.context.target.project.frameworks = ["next", "react"];
    f.selectedFiles.mockResolvedValue(scope("index.ts"));
    f.context.policy.javascript.biome[key] = {
      suspicious: { noExplicitAny: { level: "error", fix: "safe" } },
    };
    await expect(f.run()).rejects.toThrow("safe-only");
    expect(f.fix).not.toHaveBeenCalled();
  });
}
test("Biome failed report preserves source edits but never claims completed fix", async () => {
  const f = fixture("javascript");
  await expect(f.run()).rejects.toThrow();
  expect(f.report).toMatchObject({
    status: "failed",
    tool: "biome",
    version: "2.6.3",
    changed_files: ["apps/app/module.py"],
  });
});
test("Biome successful write uses report completeness, not remaining unsafe suggestions", async () => {
  const f = fixture("javascript");
  f.fix.mockResolvedValue(
    output({
      stdout: JSON.stringify({
        command: "check",
        summary: {
          changed: 1,
          unchanged: 0,
          matches: 0,
          errors: 0,
          warnings: 0,
          infos: 0,
          skipped: 0,
          diagnosticsNotPrinted: 0,
          suggestedFixesSkipped: 2,
        },
        diagnostics: [],
      }),
    }),
  );
  await f.run();
  expect(f.report.status).toBe("completed");
});
