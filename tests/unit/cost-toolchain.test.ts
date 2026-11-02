import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { WORKLOAD } from "../../scripts/development/receipt";
import { concurrencyIdentity, nativeToolchain } from "../../scripts/test-cost-environment";
import { baselineDuration, readManagedGateReports } from "../../scripts/test-cost-report";
import * as runner from "../../src/dependencies/runner";
import { output } from "./checks/fixture";
import { receipts } from "./cost-fixture";

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0).reverse()) {
    mock.mockRestore();
  }
});
test("native identity records actual versions even when executable paths stay unchanged", async () => {
  mocks.push(spyOn(Bun, "which").mockImplementation((name) => `/bin/${name}`));
  const temporary = spyOn(fs, "mkdtemp").mockResolvedValue("/neutral-probe");
  const cleanup = spyOn(fs, "rm").mockResolvedValue();
  mocks.push(temporary, cleanup);
  const native = spyOn(runner, "runProcess").mockResolvedValue(output({ stdout: "1.0.0\n" }));
  mocks.push(native);
  const before = await nativeToolchain({});
  native.mockResolvedValue(output({ stdout: "2.0.0\n" }));
  const after = await nativeToolchain({});
  expect(before).not.toEqual(after);
  expect(temporary).toHaveBeenCalledTimes(2);
  expect(native.mock.calls.every((call) => call[2].cwd === "/neutral-probe")).toBe(true);
  expect(before.npm?.version).toBe("1.0.0");
  expect(before.npm?.executable).toBe(after.npm?.executable);
  native.mockResolvedValue(output({ exit_code: 1 }));
  await expect(nativeToolchain({})).rejects.toThrow("version");
  expect(cleanup).toHaveBeenCalledTimes(3);
});
test("effective managed versions come from the gate that actually ran", () => {
  const f = receipts();
  const current = readManagedGateReports(f.check, f.integrated);
  expect(current.managed_tools).toMatchObject({
    "lint:biome": "2.6.4",
    "typecheck:typescript": "7.0.2",
    "unit:bun": "1.4.2",
  });
  const before = { executables: { typescript: "/same/path" }, managed_tools: current.managed_tools };
  const baseline = { version: 2, workload: WORKLOAD, complete: true, cache: "warm", environment: before, seconds: 400 };
  expect(() =>
    baselineDuration(baseline, {
      ...before,
      managed_tools: { ...before.managed_tools, "typecheck:typescript": "7.0.3" },
    }),
  ).toThrow("non-comparable");
  expect(concurrencyIdentity({ GOMAXPROCS: "2" }, 8)).not.toEqual(concurrencyIdentity({ GOMAXPROCS: "4" }, 8));
});
