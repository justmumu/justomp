import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import * as observations from "../../../src/dependencies/changes";
import * as executable from "../../../src/dependencies/executable";
import * as inventories from "../../../src/dependencies/inventory";
import { type Adapter, type Inventory } from "../../../src/dependencies/model";
import * as paths from "../../../src/dependencies/paths";
import * as runner from "../../../src/dependencies/runner";
import { executeDependency } from "../../../src/dependencies/service";
import * as sources from "../../../src/dependencies/source-boundaries";
import * as packaging from "../../../src/packaging/get-structure";
import { suppliedResponse } from "../../response";
import { context } from "./adapters/npm-pnpm-fixture";

const restore: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of restore.splice(0)) {
    mock.mockRestore();
  }
});

function fixture(
  options: {
    changed?: string[];
    observationError?: boolean;
    exit?: number;
    cancelled?: boolean;
    abortDuring?: "inventory" | "resolutions";
  } = {},
) {
  const ctx = context("npm");
  const controller = new AbortController();
  let resolutionReads = 0;
  const inventory: Inventory = {
    dependencies: [],
    complete: true,
    diagnostics: [],
  };
  const scope = {
    manager: "npm",
    cwd: ctx.cwd,
    owner: ctx.owner,
    env: {},
    domains: ["unit-sync"],
    pnpm: undefined,
  };
  restore.push(
    spyOn(fs, "realpath").mockResolvedValue(ctx.root),
    spyOn(paths, "safePath").mockImplementation(async (root, path) => resolve(root, path)),
    spyOn(packaging, "getPackagingStructure").mockResolvedValue({
      structure: ctx.structure,
      cacheHit: false,
      refreshed: true,
      waitMs: 0,
      publishMs: 0,
      watcher: { ready: true, healthy: true, revision: 0, watchedPaths: [] },
    }),
    spyOn(executable, "resolveManagerScope").mockResolvedValue(scope),
    spyOn(executable, "resolveExecutable").mockResolvedValue({
      ...scope,
      command: "supplied-npm",
      version: "11.12.1",
    }),
    spyOn(sources, "validateExistingSources").mockResolvedValue(undefined),
    spyOn(inventories, "readInventory").mockResolvedValue(inventory),
    spyOn(observations, "resolutionEvidence").mockImplementation(() => {
      return suppliedResponse(() => {
        if (++resolutionReads === 2 && options.abortDuring === "resolutions") {
          controller.abort();
        }
        return new Map();
      });
    }),
  );
  const fingerprints = spyOn(observations, "fingerprint").mockResolvedValueOnce(new Map());
  if (options.observationError) {
    fingerprints.mockRejectedValue(new Error("cannot observe metadata"));
  } else {
    fingerprints.mockResolvedValue(new Map((options.changed ?? []).map((path) => [path, "new"])));
  }
  const run = spyOn(runner, "runProcess").mockResolvedValue({
    exit_code: options.exit ?? 0,
    stdout: "native evidence",
    stderr: "",
    cancelled: options.cancelled ?? false,
    signal: null,
    truncated: false,
  });
  restore.push(fingerprints, run);
  const adapter: Adapter = {
    groups: ["runtime"],
    inventory: () => {
      return suppliedResponse(() => {
        if (options.abortDuring === "inventory") {
          controller.abort();
        }
        return inventory;
      });
    },
    plan: async () => ({
      steps: [{ label: "check", args: ["ci", "--dry-run"] }],
      metadata: [],
      affectedProjects: ctx.structure.projects.map((p) => p.project_id),
    }),
  };
  return {
    run,
    execute: (check = true) =>
      executeDependency(
        ctx.root,
        "sync",
        { project_id: ctx.project.project_id, check },
        { npm: adapter },
        controller.signal,
      ),
  };
}

test("check fails when native success changes dependency input metadata", async () => {
  const f = fixture({
    changed: ["packages/b/package.json", "package-lock.json", ".pnp.cjs"],
  });
  const result = await f.execute();
  expect(result.outcome).toBe("partial_change");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "check-input-changed" }));
  expect(f.run).toHaveBeenCalledTimes(1);
});

test("check permits derived PnP install outputs and reports them", async () => {
  const f = fixture({ changed: [".pnp.cjs", ".pnp.loader.mjs"] });
  const result = await f.execute();
  expect(result.outcome).toBe("success");
  expect("metadata_changes" in result && result.metadata_changes?.length).toBe(2);
});

test("check cannot pass when metadata observation fails", async () => {
  const f = fixture({ observationError: true });
  const result = await f.execute();
  expect(result.outcome).not.toBe("success");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "change-observation-failed" }));
});

test("normal sync retains its existing metadata-change success behavior", async () => {
  expect((await fixture({ changed: ["go.sum"] }).execute(false)).outcome).toBe("success");
});

test("check retains native failure and never retries or repairs", async () => {
  const f = fixture({ changed: ["package-lock.json"], exit: 1 });
  const result = await f.execute();
  expect(result.outcome).toBe("partial_change");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "native-command-failed" }));
  expect(f.run).toHaveBeenCalledTimes(1);
});

test("failed observation preserves the native failure diagnostic", async () => {
  const result = await fixture({ observationError: true, exit: 1 }).execute();
  expect(result.outcome).toBe("failed");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "change-observation-failed" }));
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "native-command-failed" }));
});

test("cancelled native check is never reported as successful", async () => {
  const f = fixture({ cancelled: true, exit: 1 });
  const result = await f.execute();
  expect(result.outcome).not.toBe("success");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "cancelled" }));
  expect(f.run).toHaveBeenCalledTimes(1);
});

for (const abortDuring of ["inventory", "resolutions"] as const) {
  test(`check cancellation during final ${abortDuring} preserves effects without reporting success`, async () => {
    const result = await fixture({ abortDuring }).execute();
    expect(result.outcome).toBe("partial_change");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "cancelled" }));
    expect("native_steps" in result && result.native_steps[0]?.exit_code).toBe(0);
  });
}

test("native rejection values are reported without awaiting thrown thenables", async () => {
  const f = fixture();
  f.run.mockRejectedValue(Promise.resolve(undefined));
  const result = await f.execute();
  expect(result.outcome).toBe("failed");
  expect(result.diagnostics).toContainEqual({ code: "dependency-error", message: "[object Promise]" });
});
