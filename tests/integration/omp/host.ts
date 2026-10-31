import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  bindPreparedExtensions,
  loadExtensions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
  ExtensionToolWrapper,
  RegisteredToolAdapter,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
export async function createHost(
  root: string,
  entry = new URL("../../../src/index.ts", import.meta.url).pathname,
  deny: boolean | string[] = false,
  factory?: ExtensionFactory,
  approvals: Record<string, "allow" | "deny"> = {},
) {
  const loaded = factory
    ? await bindPreparedExtensions(
        [{ path: entry, resolvedPath: entry, factory, error: null }],
        root,
      )
    : await loadExtensions([entry], root);
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  await mkdir(join(root, ".host"), { recursive: true });
  const auth = await AuthStorage.create(join(root, ".host/auth.db"));
  const models = new ModelRegistry(auth, join(root, ".host/models.yml"), {
    ignoreLocalModelConfig: true,
  });
  const settings = Settings.isolated({
    "tools.approvalMode": "write",
    "tools.approval": {
      ...approvals,
      ...Object.fromEntries(
        [
          "project_lint",
          "project_typecheck",
          "project_test",
          "project_integration_test",
          "dependency_list",
          "dependency_add",
          "dependency_remove",
          "dependency_update",
          "dependency_sync",
        ].map((name) => [name, "allow"]),
      ),
      ...Object.fromEntries(
        (deny === true ? ["project_inspect"] : deny || []).map((name) => [
          name,
          "deny",
        ]),
      ),
    },
  });
  const session = SessionManager.inMemory(root);
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    root,
    session,
    models,
    undefined,
    settings,
  );
  const registered = runner.getRegisteredTool("project_inspect");
  if (!registered) throw new Error("project_inspect was not registered");
  const tool = new ExtensionToolWrapper(
    new RegisteredToolAdapter(registered, runner),
    runner,
  );
  return {
    runner,
    session,
    registered,
    tool,
    getTool(name: string) {
      const entry = runner.getRegisteredTool(name);
      if (!entry) throw new Error(`${name} was not registered`);
      return new ExtensionToolWrapper(
        new RegisteredToolAdapter(entry, runner),
        runner,
      );
    },
    async close() {
      await runner.emit({ type: "session_shutdown" });
      auth.close();
    },
  };
}
