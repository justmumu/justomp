import { expect, test } from "bun:test";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import { registerProtection } from "../../../src/omp/protection";

test("protection blocks unwrapped file tools and rejects unsupported bash calls as promises", async () => {
  type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
  type Handler = (event: { toolName: string }, ctx: ExtensionContext) => unknown;
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler>();
  const ctx = {} as ExtensionContext;
  registerProtection({
    zod,
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    getAllTools() {
      throw new Error("No builtin registry");
    },
  } as unknown as ExtensionAPI);
  const call = handlers.get("tool_call"),
    start = handlers.get("session_start");
  const bash = tools.get("bash");
  if (!call || !start || !bash) {
    throw new Error("Missing protection registrations");
  }
  expect(call({ toolName: "write" }, ctx)).toMatchObject({ block: true });
  expect(call({ toolName: "dependency_add" }, ctx)).toBeUndefined();
  start({ toolName: "" }, ctx);
  expect(call({ toolName: "edit" }, ctx)).toMatchObject({ block: true });
  for (const input of [
    { command: 42 },
    { command: "echo unused", async: true },
    { command: "echo unused", ready: false },
  ]) {
    const result = bash.execute("invalid", input, undefined, undefined, ctx);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toBeInstanceOf(Error);
  }
});
