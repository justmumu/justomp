import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { checkProjectLint } from "../../../src/lint/index";
import { cleanups, cli, fixture } from "./cli-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("check-only API and CLI report unprepared without creating config or state", async () => {
  const f = await fixture();
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Check-only must not query network"));
  try {
    const result = await checkProjectLint(f.root, "python:pyproject.toml");
    expect(result.success).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.checks.map((c) => c.status)).toEqual(["not-run", "not-run"]);
    expect((await cli(f.root, "python:pyproject.toml")).exit).toBe(2);
    expect(await Bun.file(join(f.root, ".justomp/config.json")).exists()).toBe(false);
    expect(await Bun.file(join(f.root, ".justomp/packaging_structure.json")).exists()).toBe(false);
    expect(await Bun.file(join(f.root, ".justomp/lint_state.json")).exists()).toBe(false);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
  }
});
