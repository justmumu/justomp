import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatModelString } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { cfgEditMode, cfgEditModelVariants } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { registerProtection } from "../../../src/omp/protection";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { suppliedResponse } from "../../response";
import { createHost } from "./host";

test("real OMP delegation gates every patch target, allows source writes and trusted custom updates", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-protection-omp-")));
  const settings = Settings.isolated({
    "tools.approvalMode": "yolo",
    "edit.mode": "apply_patch",
  });
  let model: ExtensionContext["model"];
  const session = {
    getActiveModelString: () => (model ? formatModelString(model) : undefined),
    cwd: root,
    settings,
    hasUI: false,
    enableLsp: false,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
  };
  const nativeWrite = new WriteTool(session);
  const nativePatch = new EditTool(session, "apply_patch");
  const nativeEdit = new EditTool(session);
  await writeFile(join(root, "package.json"), '{"name":"proof","packageManager":"bun@1.4.2"}');
  await mkdir(join(root, "config"));
  await writeFile(join(root, "tsconfig.json"), '{"extends":"./config/shared.json"}');
  await writeFile(join(root, "config/shared.json"), '{"compilerOptions":{"strict":true}}');
  const h = await createHost(
    root,
    undefined,
    false,
    (pi) => {
      pi.getAllTools = () => [
        {
          name: "edit",
          description: nativeEdit.description,
          parameters: nativeEdit.parameters,
          sourceInfo: {
            path: "<builtin:edit>",
            source: "builtin",
            scope: "user",
            origin: "package",
          },
        },
        {
          name: "write",
          description: nativeWrite.description,
          parameters: nativeWrite.parameters,
          sourceInfo: {
            path: "<builtin:write>",
            source: "builtin",
            scope: "user",
            origin: "package",
          },
        },
        {
          name: "apply_patch",
          description: nativePatch.description,
          parameters: nativePatch.parameters,
          sourceInfo: {
            path: "<builtin:edit>",
            source: "builtin",
            scope: "user",
            origin: "package",
          },
        },
      ];
      registerProtection(pi);
      pi.registerTool({
        name: "project_inspect",
        label: "Fixture",
        description: "Fixture",
        parameters: pi.zod.object({}),
        execute() {
          return suppliedResponse(() => {
            return { content: [], details: {} };
          });
        },
      });
      pi.registerTool({
        name: "trusted_update",
        label: "Trusted update",
        description: "Fixture trusted custom writer",
        parameters: pi.zod.object({}),
        async execute() {
          await writeFile(join(root, "package.json"), '{"name":"custom"}');
          await writeFile(join(root, "biome.json"), '{"linter":{"enabled":true}}');
          return { content: [], details: {} };
        },
      });
    },
    {
      write: "allow",
      apply_patch: "allow",
      edit: "allow",
      bash: "allow",
      trusted_update: "allow",
    },
  );
  const runnerSettings = h.runner.sessionSettings;
  if (!runnerSettings) {
    throw new Error("Fixture needs session settings");
  }
  runnerSettings.writeValue(cfgEditMode, "apply_patch", "override");
  const createContext = h.runner.createContext.bind(h.runner);
  h.runner.createContext = (...args) => {
    const ctx = createContext(...args);
    Object.defineProperty(ctx, "model", { get: () => model });
    return ctx;
  };
  h.runner.setNativeToolResolver((name) =>
    name === "write"
      ? { tool: nativeWrite as unknown as AgentTool, makeContext: () => ({}) }
      : name === "apply_patch"
        ? { tool: nativePatch as unknown as AgentTool, makeContext: () => ({}) }
        : name === "edit"
          ? {
              tool: nativeEdit as unknown as AgentTool,
              makeContext: () => ({}),
            }
          : undefined,
  );
  const call = (name: string, params: Record<string, unknown>) =>
    h.runner.runScoped(() => h.getTool(name).execute(crypto.randomUUID(), params));
  try {
    await h.runner.emit({ type: "session_start" });
    await call("write", { path: "source.txt", content: "source" });
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source");
    await expect(call("write", { path: "package.json", content: "wrong" })).rejects.toThrow("protected");
    await expect(call("write", { path: "biome.json", content: "wrong" })).rejects.toThrow("protected");
    await expect(call("write", { path: "config/shared.json", content: "wrong" })).rejects.toThrow("protected");
    await expect(
      call("apply_patch", {
        input: "*** Begin Patch\n*** Add File: untouched.txt\n+new\n*** Delete File: package.json\n*** End Patch",
      }),
    ).rejects.toThrow("protected");
    await expect(access(join(root, "untouched.txt"))).rejects.toThrow();
    const edit = h.getTool("edit");
    expect(edit.parameters).toBe(nativeEdit.parameters);
    settings.writeValue(cfgEditMode, "replace", "override");
    runnerSettings.writeValue(cfgEditMode, "replace", "override");
    expect(edit.parameters).toBe(nativeEdit.parameters);
    await call("edit", {
      path: "source.txt",
      old_string: "source",
      new_string: "updated",
    });
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("updated");
    settings.writeValue(cfgEditModelVariants, { "openai/gpt": "apply_patch" }, "override");
    runnerSettings.writeValue(cfgEditModelVariants, { "openai/gpt": "apply_patch" }, "override");
    model = { provider: "openai", id: "gpt-5" } as NonNullable<ExtensionContext["model"]>;
    expect(edit.parameters).toBe(nativeEdit.parameters);
    await expect(
      call("edit", {
        path: "source.txt",
        old_string: "updated",
        new_string: "wrong",
        input: "*** Begin Patch\n*** Delete File: package.json\n*** End Patch",
      }),
    ).rejects.toThrow("protected");
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("updated");
    await call("trusted_update", {});
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"custom"}');
    expect(await readFile(join(root, "biome.json"), "utf8")).toBe('{"linter":{"enabled":true}}');
    const denied = await call("bash", {
      command: "printf wrong > package.json",
    });
    expect(denied.isError).toBe(true);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe('{"name":"custom"}');
    const ok = await call("bash", { command: "printf source2 > second.txt" });
    expect(ok.isError).not.toBe(true);
    expect(await readFile(join(root, "second.txt"), "utf8")).toBe("source2");
    await expect(call("bash", { command: "true", async: true })).rejects.toThrow("foreground");
  } finally {
    await h.close();
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
