import { expect, test } from "bun:test";
import { type PushPorts, runPushGate } from "../../../src/prepush/pipeline";

function ports(calls: string[], fail = "", incomplete = false): PushPorts {
  const outcome = (stage: string, id?: string) => {
    const label = id ? `${stage}:${id}` : stage;
    calls.push(label);
    return {
      stage,
      ...(id ? { project_id: id } : {}),
      success: label !== fail,
      complete: label !== fail || !incomplete,
      effects: stage === "preparation" ? ["pyproject.toml"] : [],
      details: {},
    };
  };
  return {
    dependencyKey: (id) => (id.startsWith("shared") ? "workspace" : id),
    prepare: async () => outcome("preparation"),
    run: async (stage, id) => outcome(stage, id),
  };
}
test("all locks precede one preparation and full per-project checks", async () => {
  const calls: string[] = [];
  const result = await runPushGate(
    ["shared-a", "shared-b", "api"],
    ports(calls),
    new AbortController().signal,
  );
  expect(result.success).toBe(true);
  expect(result.selected_projects).toEqual(["shared-a", "shared-b", "api"]);
  expect(result.changed_files).toEqual(["pyproject.toml"]);
  expect(calls).toEqual([
    "dependency:shared-a",
    "dependency:api",
    "preparation",
    "format:shared-a",
    "lint:shared-a",
    "typecheck:shared-a",
    "unit:shared-a",
    "format:shared-b",
    "lint:shared-b",
    "typecheck:shared-b",
    "unit:shared-b",
    "format:api",
    "lint:api",
    "typecheck:api",
    "unit:api",
  ]);
});
test("failed lock never reaches preparation or repair", async () => {
  const calls: string[] = [];
  const result = await runPushGate(
    ["api", "web"],
    ports(calls, "dependency:web"),
    new AbortController().signal,
  );
  expect(calls).toEqual(["dependency:api", "dependency:web"]);
  expect(result.complete).toBe(true);
  expect(result.success).toBe(false);
  expect(result.errors.join()).toContain("web");
});
test("format, lint, types and unit/coverage failures stop at their own stage", async () => {
  for (const stage of ["format", "lint", "typecheck", "unit"]) {
    const calls: string[] = [];
    const result = await runPushGate(
      ["api", "web"],
      ports(calls, `${stage}:api`),
      new AbortController().signal,
    );
    expect(result.complete).toBe(true);
    expect(result.success).toBe(false);
    expect(calls.at(-1)).toBe(`${stage}:api`);
    expect(result.stages.at(-1)?.stage).toBe(stage);
  }
});
test("incomplete preparation and cancellation cannot succeed", async () => {
  const result = await runPushGate(
    ["api"],
    ports([], "preparation", true),
    new AbortController().signal,
  );
  expect(result.complete).toBe(false);
  const controller = new AbortController();
  const p = ports([]);
  p.prepare = async () => {
    controller.abort();
    return {
      stage: "preparation",
      success: true,
      complete: true,
      effects: ["lock"],
      details: {},
    };
  };
  const cancelled = await runPushGate(["api"], p, controller.signal);
  expect(cancelled.cancelled).toBe(true);
  expect(cancelled.success).toBe(false);
  expect(cancelled.changed_files).toEqual(["lock"]);
});
test("no projects is explicit success without preparation", async () => {
  const calls: string[] = [];
  const result = await runPushGate(
    [],
    ports(calls),
    new AbortController().signal,
  );
  expect(result.success).toBe(true);
  expect(result.summary).toBe("no-projects");
  expect(calls).toEqual([]);
});
