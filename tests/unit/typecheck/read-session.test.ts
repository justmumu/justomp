import { afterEach, expect, spyOn, test } from "bun:test";
import { type AdapterContext, type ProcessResult } from "../../../src/dependencies/model";
import * as runtime from "../../../src/lint/runtime";
import * as native from "../../../src/typecheck/javascript/native";
import { JavascriptConfigRead } from "../../../src/typecheck/javascript/read-session";
import { type TypecheckTarget } from "../../../src/typecheck/targets";

const target = {
  root: "/repo",
  scope: { cwd: "/repo/app" },
} as TypecheckTarget;
const manager = { manager: "npm", version: "11.12.1" } as AdapterContext;
const success: ProcessResult = {
  signal: null,
  exit_code: 0,
  stdout: '{"files":["a.ts"]}',
  stderr: "",
  truncated: false,
  cancelled: false,
};
const restore: (() => void)[] = [];
afterEach(() => {
  for (const fn of restore.splice(0).reverse()) {
    fn();
  }
});
function spies() {
  const resolve = spyOn(runtime, "lintManagerContext").mockResolvedValue(manager);
  const run = spyOn(native, "typescriptRun").mockResolvedValue(success);
  restore.push(
    () => resolve.mockRestore(),
    () => run.mockRestore(),
  );
  return { resolve, run };
}
test("one config traversal shares its manager probe while reading each config freshly", async () => {
  const { resolve, run } = spies();
  const read = new JavascriptConfigRead(new AbortController().signal);
  const args = ["--project", "/repo/app/tsconfig.json"];
  const [a, b] = await Promise.all([read.showConfig(target, args), read.showConfig(target, args)]);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(2);
  a.stdout = "caller mutation";
  expect(b.stdout).toBe(success.stdout);
  expect((await read.showConfig(target, args)).stdout).toBe(success.stdout);
  await read.showConfig(target, ["--project", "/repo/app/test.json"]);
  expect(run).toHaveBeenCalledTimes(4);
  expect(resolve).toHaveBeenCalledTimes(1);
});
test("targets and separate read phases never inherit another compiler result", async () => {
  const { resolve, run } = spies();
  const signal = new AbortController().signal;
  const read = new JavascriptConfigRead(signal);
  await read.showConfig(target, []);
  await read.showConfig({ ...target, root: "/other" }, []);
  run.mockResolvedValue({ ...success, stdout: '{"files":["new.ts"]}' });
  expect((await new JavascriptConfigRead(signal).showConfig(target, [])).stdout).toContain("new.ts");
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenCalledTimes(3);
});
test("failed, cancelled and incomplete compiler results never prevent another read", async () => {
  const { run } = spies();
  const read = new JavascriptConfigRead(new AbortController().signal);
  for (const result of [
    { ...success, exit_code: 1 },
    { ...success, truncated: true },
    { ...success, cancelled: true },
    { ...success, stderr: "warning" },
  ]) {
    run.mockResolvedValueOnce(result);
    expect(await read.showConfig(target, [])).toEqual(result);
  }
  expect(await read.showConfig(target, [])).toEqual(success);
  expect(run).toHaveBeenCalledTimes(5);
});
test("rejected manager probes and config reads do not poison subsequent attempts", async () => {
  const { resolve, run } = spies();
  const read = new JavascriptConfigRead(new AbortController().signal);
  resolve.mockRejectedValueOnce(new Error("probe failed"));
  await expect(read.showConfig(target, [])).rejects.toThrow("probe failed");
  run.mockRejectedValueOnce(new Error("compiler failed"));
  await expect(read.showConfig(target, [])).rejects.toThrow("compiler failed");
  expect(await read.showConfig(target, [])).toEqual(success);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenCalledTimes(2);
});
test("cancellation rejects a retained manager context and an in-flight config completion", async () => {
  const { run } = spies();
  const controller = new AbortController();
  const read = new JavascriptConfigRead(controller.signal);
  await read.showConfig(target, []);
  controller.abort(new Error("cancelled"));
  await expect(read.showConfig(target, [])).rejects.toThrow("cancelled");
  const other = new AbortController();
  run.mockImplementationOnce(async () => {
    other.abort(new Error("during read"));
    return success;
  });
  await expect(new JavascriptConfigRead(other.signal).showConfig(target, [])).rejects.toThrow("during read");
});
