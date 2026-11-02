import { afterEach, expect, spyOn, test } from "bun:test";
import { FORMAT_DEFAULTS } from "../../../src/config/format/defaults";
import { lintPolicyKey, resolveLintConfig } from "../../../src/config/lint/resolve";
import * as config from "../../../src/config/load";
import { withDomains } from "../../../src/dependencies/queue";
import * as prettier from "../../../src/format/engines/prettier";
import * as python from "../../../src/format/engines/python";
import * as files from "../../../src/format/files";
import { filterPythonFormatScope } from "../../../src/format/python-scope";
import * as scope from "../../../src/format/scope";
import { formatProject } from "../../../src/format/service";
import * as preparation from "../../../src/lint/prepare";
import * as projection from "../../../src/lint/projection";
import { lintAdapters } from "../../../src/lint/service";
import { LintStateStore } from "../../../src/lint/state";
import * as targets from "../../../src/lint/targets";
import * as packaging from "../../../src/packaging/get-structure";
import { suppliedResponse } from "../../response";
import { output, target } from "../checks/fixture";

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
function setup(paths: string[]) {
  const selected = target("python");
  selected.scope.domains = ["manager:/repo"];
  const policy = {
    format: FORMAT_DEFAULTS,
    lint: resolveLintConfig().policy,
    wrote: false,
  } as config.LoadedConfig;
  const inspect = keep(
    spyOn(packaging, "getPackagingStructure").mockResolvedValue({
      structure: selected.structure,
    } as packaging.PackagingResult),
  );
  keep(spyOn(targets, "resolveLintTarget").mockResolvedValue(selected));
  const load = keep(spyOn(config, "loadConfig").mockResolvedValue(policy));
  const collect = keep(
    spyOn(scope, "collectFormatScope").mockResolvedValue({
      ecosystem: "python",
      files: paths,
    }),
  );
  const read = keep(
    spyOn(files, "readFormatFile").mockResolvedValue({
      text: "before",
      identity: "1",
      mode: 0o644,
    }),
  );
  const publish = keep(spyOn(files, "publishFormatFile").mockResolvedValue());
  const format = keep(spyOn(prettier, "formatPrettier").mockResolvedValue("after"));
  const prepare = keep(
    spyOn(preparation, "prepareLint").mockRejectedValue(new Error("Common files must not prepare native tooling")),
  );
  return {
    selected,
    inspect,
    load,
    collect,
    read,
    publish,
    format,
    prepare,
    policy,
  };
}
test("empty automatic scope succeeds without native setup or formatter calls", async () => {
  const f = setup([]);
  const result = await formatProject("/repo", f.selected.project.project_id);
  expect(result).toMatchObject({
    success: true,
    complete: true,
    summary: "no-files",
    files: [],
    formatters: [],
  });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.format).not.toHaveBeenCalled();
});
test("unchanged and changed files are distinguished without unnecessary publication", async () => {
  const f = setup(["a.md", "b.md"]);
  f.format.mockResolvedValueOnce("before");
  const counts: number[] = [];
  const result = await formatProject("/repo", f.selected.project.project_id, {
    onProgress(progress) {
      if (progress.stage === "formatting") {
        counts.push(progress.completed);
      }
    },
  });
  expect(counts).toEqual([0, 1]);
  expect(result.success).toBe(true);
  expect(result.files.map((file) => file.status)).toEqual(["unchanged", "changed"]);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.prepare).not.toHaveBeenCalled();
});
test("parse failure preserves earlier writes and leaves remaining files not-run", async () => {
  const f = setup(["a.md", "b.md", "c.md"]);
  f.format.mockResolvedValueOnce("after").mockRejectedValueOnce(new Error("Invalid syntax"));
  const result = await formatProject("/repo", f.selected.project.project_id);
  expect(result).toMatchObject({
    success: false,
    complete: false,
    cancelled: false,
  });
  expect(result.files.map((file) => file.status)).toEqual(["changed", "failed", "not-run"]);
  expect(f.publish).toHaveBeenCalledTimes(1);
});
test("abort during API formatting prevents publication and preserves prior effects", async () => {
  const f = setup(["a.md", "b.md", "c.md"]);
  const controller = new AbortController();
  f.format.mockResolvedValueOnce("after").mockImplementationOnce(() => {
    return suppliedResponse(() => {
      controller.abort(new Error("stop"));
      return "after";
    });
  });
  const result = await formatProject("/repo", f.selected.project.project_id, {
    signal: controller.signal,
  });
  expect(result.cancelled).toBe(true);
  expect(result.files.map((file) => file.status)).toEqual(["changed", "failed", "not-run"]);
  expect(f.publish).toHaveBeenCalledTimes(1);
});
test("invalid entire selection is rejected before configuration flush or native preparation", async () => {
  const f = setup(["a.md"]);
  const result = await formatProject("/repo", f.selected.project.project_id, {
    files: ["a.md", "../foreign.md"],
  });
  expect(result).toMatchObject({ success: false, files: [] });
  expect(f.load.mock.calls.some((call) => call[1]?.flush)).toBe(false);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});
test("metadata refresh failure retains file and config flush effects", async () => {
  const f = setup(["pyproject.toml"]);
  f.load.mockResolvedValue({ ...f.policy, wrote: true });
  f.inspect
    .mockResolvedValueOnce({
      structure: f.selected.structure,
    } as packaging.PackagingResult)
    .mockResolvedValueOnce({
      structure: f.selected.structure,
    } as packaging.PackagingResult)
    .mockRejectedValueOnce(new Error("refresh unavailable"));
  const result = await formatProject("/repo", f.selected.project.project_id);
  expect(result.success).toBe(false);
  expect(result.files[0]?.status).toBe("changed");
  expect(result.preparation_changes).toEqual([
    {
      project_id: f.selected.project.project_id,
      path: ".justomp/config.json",
      kind: "updated",
    },
  ]);
  expect(result.errors.at(-1)?.code).toBe("refresh-failed");
});
function native(f: ReturnType<typeof setup>) {
  const id = f.selected.project.project_id;
  const tools = { ruff: "0.17.3" };
  const store = {
    state: {
      schema: 2,
      projects: {
        [id]: {
          ecosystem: "python",
          tools,
          ready: true,
          policy_hash: lintPolicyKey(f.policy.lint.python),
        },
      },
      waves: {
        python: { projects: [id], versions: { [id]: tools }, complete: true },
      },
    },
  } as unknown as LintStateStore;
  keep(spyOn(LintStateStore, "load").mockResolvedValue(store));
  const plan = keep(
    spyOn(projection, "planProjection").mockResolvedValue({
      target: f.selected,
      current: true,
      files: [],
      configs: { lint: "/config", format: "/config" },
    }),
  );
  const verify = keep(spyOn(lintAdapters.python, "verify").mockResolvedValue(true));
  const run = keep(spyOn(python, "formatPython").mockResolvedValue(output()));
  f.prepare.mockResolvedValue({
    projects: {},
    status: "ready",
    action: "prepared",
    tools,
    affected_projects: [id, "python:sibling"],
    changes: [
      {
        project_id: "python:sibling",
        path: "sibling/pyproject.toml",
        kind: "updated",
      },
    ],
    errors: [],
    complete: true,
    cancelled: false,
  });
  return { run, verify, plan, store };
}
test("native failure accounts observed writes, keeps earlier effects and stops subsequent files", async () => {
  const f = setup(["a.py", "b.py", "c.py"]);
  const n = native(f);
  n.run.mockResolvedValueOnce(output()).mockResolvedValueOnce(output({ exit_code: 1, stderr: "formatter failed" }));
  const snapshot = (text: string) => ({ text, identity: "1", mode: 0o644 });
  f.read
    .mockResolvedValueOnce(snapshot("before"))
    .mockResolvedValueOnce(snapshot("after"))
    .mockResolvedValueOnce(snapshot("before"))
    .mockResolvedValueOnce(snapshot("partially written"));
  const result = await formatProject("/repo", f.selected.project.project_id);
  expect(result).toMatchObject({ success: false, complete: false });
  expect(result.files.map((file) => file.status)).toEqual(["changed", "failed", "not-run"]);
  expect(result.files[1]?.changed).toBe(true);
  expect(result.formatters).toEqual([{ engine: "ruff", version: "0.17.3" }]);
  expect(result.affected_projects).toContain("python:sibling");
  expect(result.preparation_changes).toEqual([
    {
      project_id: "python:sibling",
      path: "sibling/pyproject.toml",
      kind: "updated",
    },
  ]);
  expect(f.prepare.mock.calls[0]?.[4]).toEqual(["python"]);
  expect(n.run).toHaveBeenCalledTimes(2);
});
test("native readiness is verified under the execution lease without repair", async () => {
  const f = setup(["main.py"]);
  const n = native(f);
  n.verify.mockResolvedValue(false);
  const result = await formatProject("/repo", f.selected.project.project_id);
  expect(result.files[0]?.status).toBe("not-run");
  expect(result.errors.at(-1)?.code).toBe("not-ready");
  expect(n.run).not.toHaveBeenCalled();
  expect(f.prepare).toHaveBeenCalledTimes(1);
});
test("partial preparation metadata changes refresh inspection and survive refresh failure", async () => {
  const f = setup(["main.py"]);
  native(f);
  f.prepare.mockResolvedValue({
    projects: {},
    status: "failed",
    action: "prepared",
    tools: {},
    affected_projects: ["python:sibling", "python:sibling"],
    changes: [
      {
        project_id: "python:sibling",
        path: "sibling/pyproject.toml",
        kind: "updated",
      },
    ],
    errors: [{ code: "setup-failed", message: "failure after manifest update" }],
    complete: false,
    cancelled: false,
  });
  f.inspect
    .mockResolvedValueOnce({
      structure: f.selected.structure,
    } as packaging.PackagingResult)
    .mockRejectedValueOnce(new Error("refresh failed"));
  const result = await formatProject("/repo", f.selected.project.project_id);
  expect(result.preparation_changes).toHaveLength(1);
  expect(result.affected_projects).toEqual(["python:sibling"]);
  expect(result.errors.map((error) => error.code)).toEqual(["setup-failed", "refresh-failed"]);
});
test("format shares dependency domains and rejects ownership changes after waiting", async () => {
  const f = setup(["a.md"]);
  let release = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const mutation = withDomains(f.selected.scope.domains, undefined, async () => {
    entered();
    await gate;
  });
  await held;
  let wait = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  const waiting = new Promise<void>((resolve) => {
    wait = resolve;
  });
  const pending = formatProject("/repo", f.selected.project.project_id, {
    onProgress: (progress) => {
      if (progress.stage === "waiting") {
        wait();
      }
    },
  });
  await waiting;
  expect(f.publish).not.toHaveBeenCalled();
  f.selected.structure.projects.push({
    ...f.selected.project,
    project_id: "python:child",
    path: "apps/app/child",
  });
  release();
  await mutation;
  const result = await pending;
  expect(result.errors[0]?.code).toBe("ownership-changed");
  expect(f.publish).not.toHaveBeenCalled();
});
test("waiting calls use current policy and cancelled queue waiters never write", async () => {
  const f = setup(["a.md"]);
  let release = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  const held = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const mutation = withDomains(f.selected.scope.domains, undefined, async () => {
    enter();
    await gate;
  });
  await held;
  let wait = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  const waiting = new Promise<void>((resolve) => {
    wait = resolve;
  });
  const pending = formatProject("/repo", f.selected.project.project_id, {
    onProgress: (progress) => {
      if (progress.stage === "waiting") {
        wait();
      }
    },
  });
  await waiting;
  f.load.mockResolvedValue({
    ...f.policy,
    format: {
      ...FORMAT_DEFAULTS,
      prettier: { ...FORMAT_DEFAULTS.prettier, singleQuote: true },
    },
  });
  const controller = new AbortController();
  const cancelled = formatProject("/repo", f.selected.project.project_id, {
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.stage === "waiting") {
        controller.abort();
      }
    },
  });
  expect((await cancelled).cancelled).toBe(true);
  release();
  await mutation;
  expect((await pending).success).toBe(true);
  expect(f.format.mock.calls[0]?.[2].singleQuote).toBe(true);
  expect(f.publish).toHaveBeenCalledTimes(1);
});
test("metadata changed before a later parse failure still refreshes inspection", async () => {
  const f = setup(["pyproject.toml", "z.json"]);
  f.format.mockResolvedValueOnce("after").mockRejectedValueOnce(new Error("invalid JSON"));
  const result = await formatProject("/repo", f.selected.project.project_id, {
    onProgress() {
      throw new Error("Reporting failed");
    },
  });
  expect(result.files.map((file) => file.status)).toEqual(["changed", "failed"]);
  expect(f.inspect).toHaveBeenCalledTimes(3);
  expect(f.inspect.mock.calls.at(-1)?.[1]).toEqual({ refresh: true });
});

test("shared Ruff exclusions reject an explicit mixed selection before any writes", async () => {
  const f = setup(["README.md", ".private/draft.py"]);
  f.collect.mockImplementation(async (target, _format, lint, requested) =>
    filterPythonFormatScope(
      { ecosystem: "python", files: ["README.md", ".private/draft.py"] },
      target.scope.cwd,
      lint.python,
      requested,
    ),
  );
  const result = await formatProject("/repo", f.selected.project.project_id, {
    files: ["README.md", ".private/draft.py"],
  });
  expect(result.errors[0]?.code).toBe("invalid-files");
  expect(f.load.mock.calls.some((call) => call[1]?.flush)).toBe(false);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalled();
});

test("Ruff scope is revalidated with current shared policy after waiting before writes", async () => {
  const f = setup(["README.md", "main.py"]);
  const n = native(f);
  f.collect.mockImplementation(async (target, _format, lint, requested) =>
    filterPythonFormatScope(
      { ecosystem: "python", files: ["README.md", "main.py"] },
      target.scope.cwd,
      lint.python,
      requested,
    ),
  );
  const current = structuredClone(f.policy);
  current.lint.python.ruff.exclude = ["main.py"];
  f.load.mockResolvedValueOnce(f.policy).mockResolvedValueOnce(f.policy).mockResolvedValue(current);
  const result = await formatProject("/repo", f.selected.project.project_id, {
    files: ["README.md", "main.py"],
  });
  expect(result.errors[0]?.code).toBe("invalid-files");
  expect(f.collect).toHaveBeenCalledTimes(2);
  expect(f.publish).not.toHaveBeenCalled();
  expect(n.run).not.toHaveBeenCalled();
});
