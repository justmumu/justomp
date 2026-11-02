import { expect, test } from "bun:test";
import { type TypecheckToolContext } from "../../../src/typecheck/adapters/types";
import { readyTypecheckProjection } from "../../../src/typecheck/readiness";

function context(signal = new AbortController().signal) {
  return {
    target: { root: "/repo" },
    policy: {},
    versions: {},
    signal,
  } as TypecheckToolContext;
}
test("readiness resolves one current projection after tool probes, including their changes", async () => {
  const ctx = context(),
    calls: string[] = [];
  let current = true;
  const adapter = {
    async verifyTools() {
      calls.push("tools");
      current = false;
      return true;
    },
    async plan() {
      calls.push("projection");
      return { target: ctx.target, files: [], configs: { check: [] }, current };
    },
  };
  expect(await readyTypecheckProjection(adapter, ctx)).toBeUndefined();
  expect(calls).toEqual(["tools", "projection"]);
  adapter.verifyTools = async () => {
    current = true;
    return true;
  };
  expect((await readyTypecheckProjection(adapter, ctx))?.current).toBe(true);
});
test("unready tools and cancellation cannot yield a ready projection", async () => {
  const controller = new AbortController(),
    ctx = context(controller.signal);
  let plans = 0;
  const adapter = {
    async verifyTools() {
      return false;
    },
    async plan() {
      plans++;
      return {
        target: ctx.target,
        files: [],
        configs: { check: [] },
        current: true,
      };
    },
  };
  expect(await readyTypecheckProjection(adapter, ctx)).toBeUndefined();
  expect(plans).toBe(0);
  adapter.verifyTools = async () => {
    controller.abort(new Error("cancelled"));
    return true;
  };
  await expect(readyTypecheckProjection(adapter, ctx)).rejects.toThrow("cancelled");
  expect(plans).toBe(0);
});
