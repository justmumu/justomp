import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
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
  deny = false,
) {
  const loaded = await loadExtensions([entry], root);
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  await mkdir(join(root, ".host"), { recursive: true });
  const auth = await AuthStorage.create(join(root, ".host/auth.db"));
  const models = new ModelRegistry(auth, join(root, ".host/models.yml"), {
    ignoreLocalModelConfig: true,
  });
  const settings = Settings.isolated({
    "tools.approvalMode": "write",
    ...(deny ? { "tools.approval": { project_inspect: "deny" } } : {}),
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
    async close() {
      await runner.emit({ type: "session_shutdown" });
      auth.close();
    },
  };
}
