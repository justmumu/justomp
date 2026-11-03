import { expect, spyOn, test } from "bun:test";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import { type WithSessionRoot } from "../../../src/omp/dependency-tools";
import { registerReleaseTools } from "../../../src/omp/release-tools";
import * as bump from "../../../src/release/bump";
import { emptyReleaseResult } from "../../../src/release/effects";
import { type ReleaseResult } from "../../../src/release/model";
import { releaseSchemas } from "../../../src/release/schemas";
import * as changelog from "../../../src/release/service";
import * as tag from "../../../src/release/tag";
import { lifecycleFixture } from "./lifecycle-fixture";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
function registered(withRoot: WithSessionRoot) {
  const tools = new Map<string, Tool>();
  registerReleaseTools(
    {
      zod,
      registerTool(tool: Tool) {
        tools.set(tool.name, tool);
      },
    } as ExtensionAPI,
    withRoot,
  );
  return tools;
}
function requiredTool(tools: Map<string, Tool>, name: string): Tool {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Missing tool ${name}`);
  }
  return tool;
}
function schema(tools: Map<string, Tool>, name: string) {
  const parameters = requiredTool(tools, name).parameters;
  const expected =
    name === "repo_bump"
      ? releaseSchemas.bump
      : name === "repo_changelog"
        ? releaseSchemas.changelog
        : releaseSchemas.tag;
  expect(parameters).toBe(expected);
  return expected;
}
const context = { cwd: "/repo/child" } as ExtensionContext;

test("release tools require exec approval and reject extra or invalid arguments before entering the session", async () => {
  let entered = false;
  const tools = registered((root, signal, work) => {
    entered = true;
    return work(root, signal ?? new AbortController().signal);
  });
  expect([...tools.keys()]).toEqual(["repo_changelog", "repo_bump", "repo_release_tag"]);
  for (const tool of tools.values()) {
    expect(tool.approval).toBe("exec");
    const result = await tool.execute("invalid", { unexpected: true }, undefined, undefined, context);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ success: false, status: "rejected", changed_files: [] });
  }
  for (const input of [{}, { increment: "latest" }, { increment: "patch", extra: true }]) {
    expect(schema(tools, "repo_bump").safeParse(input).success).toBe(false);
  }
  for (const increment of ["patch", "minor", "major"]) {
    expect(schema(tools, "repo_bump").safeParse({ increment }).success).toBe(true);
  }
  expect(schema(tools, "repo_changelog").safeParse({}).success).toBe(true);
  expect(schema(tools, "repo_release_tag").safeParse({}).success).toBe(true);
  expect(entered).toBe(false);
});

test("release tools forward session roots and cancellation and preserve service effects and outcomes", async () => {
  const caller = new AbortController(),
    active = new AbortController();
  const tools = registered((root, signal, work) => {
    expect(root).toBe(context.cwd);
    expect(signal).toBe(caller.signal);
    return work("/canonical/child", active.signal);
  });
  const results: [ReleaseResult, ReleaseResult, ReleaseResult] = [
    { ...emptyReleaseResult("/canonical"), success: true, status: "success" as const, changed_files: ["CHANGELOG.md"] },
    {
      ...emptyReleaseResult("/canonical"),
      status: "partial_change" as const,
      changed_files: ["package.json"],
      cancelled: true,
    },
    { ...emptyReleaseResult("/canonical"), status: "failed" as const, created: null, observed_target: null },
  ];
  const spies = [
    spyOn(changelog, "updateRepositoryChangelog").mockResolvedValue(results[0]),
    spyOn(bump, "bumpRepository").mockResolvedValue(results[1]),
    spyOn(tag, "tagRepository").mockResolvedValue(results[2]),
  ];
  try {
    for (const [index, name] of ["repo_changelog", "repo_bump", "repo_release_tag"].entries()) {
      const input = name === "repo_bump" ? { increment: "minor" } : {};
      const tool = requiredTool(tools, name);
      const result = await tool.execute("release", input, caller.signal, undefined, context);
      const expected = results[index];
      if (!expected) {
        throw new Error("Missing supplied result");
      }
      expect(spies[index]).toHaveBeenCalledWith("/canonical/child", input, active.signal);
      expect(result.details).toBe(expected);
      expect(result.isError).toBe(!expected.success);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
    }
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
});

test("session failures are structured release failures including cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  const tools = registered(() => Promise.reject(Object.assign(new Error("session closed"), { code: "closed" })));
  for (const signal of [undefined, controller.signal]) {
    const result = await requiredTool(tools, "repo_release_tag").execute("closed", {}, signal, undefined, context);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      success: false,
      status: signal ? "cancelled" : "rejected",
      cancelled: Boolean(signal),
      created: false,
      diagnostics: [{ code: "closed", message: "session closed" }],
    });
  }
});

for (const transition of ["shutdown", "root change"] as const) {
  test(`release calls cancel and finish before session ${transition} releases ownership`, async () => {
    const fixture = lifecycleFixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const aborted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const service = spyOn(bump, "bumpRepository").mockImplementation(async (root, _input, signal) => {
      if (!signal) {
        throw new Error("Missing session signal");
      }
      entered.resolve(signal);
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await finish.promise;
      return { ...emptyReleaseResult(root), status: "cancelled", cancelled: true };
    });
    try {
      const tool = requiredTool(fixture.tools, "repo_bump");
      const call = tool.execute("pending", { increment: "patch" }, undefined, undefined, context);
      const signal = await entered.promise;
      const closing = transition === "shutdown" ? fixture.emit("session_shutdown") : fixture.inspect("/next");
      await aborted.promise;
      expect(signal.aborted).toBe(true);
      expect(fixture.events).not.toContain("packaging:release:/repo/child");
      finish.resolve();
      expect((await call).details).toMatchObject({ cancelled: true, status: "cancelled" });
      await closing;
      expect(fixture.events).toContain("packaging:release:/repo/child");
      await fixture.emit("session_shutdown");
    } finally {
      finish.resolve();
      service.mockRestore();
      fixture.restore();
    }
  });
}
