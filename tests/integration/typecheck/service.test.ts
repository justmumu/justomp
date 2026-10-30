import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  checkProjectTypecheck,
  prepareProjectTypecheck,
  typecheckProject,
} from "../../../src/typecheck/index";
import { cleanup, fixture, id } from "./service-fixture";

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
test("selected preparation validates identity before writes; check-only never sets up", async () => {
  const f = await fixture(),
    network = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("No network"),
    );
  try {
    await expect(
      prepareProjectTypecheck(f.root, "python:missing"),
    ).rejects.toThrow("Unknown project_id");
    await expect(typecheckProject(f.root, "python:missing")).rejects.toThrow(
      "Unknown project_id",
    );
    const result = await checkProjectTypecheck(f.root, id);
    expect(result.complete).toBe(false);
    expect(result.checks[0]?.status).toBe("not-run");
    for (const path of [
      ".justomp/config.json",
      ".justomp/typecheck_state.json",
      ".justomp/packaging_structure.json",
      "uv.lock",
    ])
      expect(await Bun.file(join(f.root, path)).exists()).toBe(false);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
