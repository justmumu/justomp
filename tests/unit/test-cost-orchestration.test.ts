import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { caseCosts, costArguments, costStores, fixtureCosts } from "../../scripts/test-cost-analysis";
import { measureGate } from "../../scripts/test-cost-gate";
import * as runner from "../../scripts/test-cost-runner";
import { suppliedResponse } from "../response";
import { receipts } from "./cost-fixture";

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0).reverse()) {
    mock.mockRestore();
  }
});
function files(read: (path: string) => string | Promise<string>) {
  const mock = spyOn(fs, "readFile").mockImplementation(((path: unknown) =>
    suppliedResponse(() => read(String(path)))) as unknown as typeof fs.readFile);
  mocks.push(mock);
  return mock;
}
test("cost orchestration runs each managed lane once and reads durable evidence", async () => {
  const f = receipts();
  const native = spyOn(runner, "runCostStage").mockResolvedValue({ exit_code: 0, seconds: 2 });
  mocks.push(native);
  files((path) => JSON.stringify(path.endsWith("check.json") ? f.check : f.integrated));
  const result = await measureGate("/repo", "/reports", {});
  expect(result.gate?.counts.tests).toBe(2);
  expect(result.error).toBeUndefined();
  expect(native.mock.calls.map((call) => call[0][2])).toEqual(["check", "integration"]);
  expect(native.mock.calls[1]?.[0]).toContain("--timeout-seconds");
  native.mockResolvedValue({ exit_code: 1, seconds: 1 });
  files(() => {
    throw Object.assign(new Error("missing integration receipt"), { code: "ENOENT" });
  });
  const failed = await measureGate("/repo", "/reports", {});
  expect(failed.stages).toHaveLength(1);
  expect(failed.error).toContain("missing integration receipt");
  expect(failed.gate).toBeUndefined();
});
test("cost selections and stores preserve the inherited environment without deleting caches", () => {
  expect(costArguments(["--cold", "--baseline", "old.json"])).toEqual({ cold: true, baseline: "old.json" });
  for (const args of [["--unknown"], ["--baseline"], ["--cold", "--cold"]]) {
    expect(() => costArguments(args)).toThrow();
  }
  expect(costStores("/reports", false).JUSTOMP_TEST_TIMINGS).toBe("/reports/fixture-timings.jsonl");
  expect(costStores("/reports", true).GOCACHE).toBe("/reports/cache/go-build");
  expect(costStores("/reports", true).PATH).toBe(process.env.PATH);
  expect(
    caseCosts(
      [{ name: "u", file: "unit.ts", seconds: 1 }],
      [
        { name: "n", file: "flow.native.test.ts", seconds: 2 },
        { name: "f", file: "flow.test.ts", seconds: 3 },
      ],
    ),
  ).toEqual({
    groups: { unit: 1, local: 3, native: 2 },
    files: { "unit.ts": 1, "flow.native.test.ts": 2, "flow.test.ts": 3 },
  });
});
test("fixture timing records are aggregated while missing files and malformed records remain distinct", async () => {
  files(() => '{"stage":"install","seconds":1}\n{"stage":"install","seconds":2}\n');
  expect(await fixtureCosts("/timings")).toEqual({ install: { calls: 2, seconds: 3 } });
  files(() => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  expect(await fixtureCosts("/timings")).toEqual({});
  files(() => '{"stage":"install","seconds":-1}\n');
  await expect(fixtureCosts("/timings")).rejects.toThrow("Invalid fixture timing");
  files(() => {
    throw new Error("denied");
  });
  await expect(fixtureCosts("/timings")).rejects.toThrow("denied");
});
