import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import * as config from "../../../src/config/load";
import * as lint from "../../../src/lint/coordinator";
import registerInspection from "../../../src/omp/extension";
import * as packaging from "../../../src/packaging/get-structure";
import * as precommit from "../../../src/precommit/install";
import * as prepush from "../../../src/prepush/install";
import * as testing from "../../../src/testing/coordinator";
import * as typecheck from "../../../src/typecheck/coordinator";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Handler = (event: never, ctx: ExtensionContext) => unknown;

/** Supplied host/inspection/native ports; no real host, watcher, filesystem or process setup. */
export function lifecycleFixture(releaseError?: Error) {
  const events: string[] = [];
  const notices: string[] = [];
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const ready = Promise.withResolvers<void>();
  let reconciled = 0;
  const owned = (name: string) => ({
    coordinator: {
      subscribe() {
        return () => {
          events.push(`${name}:unsubscribe`);
        };
      },
      subscribeProgress() {
        return () => {
          events.push(`${name}:unsubscribe-progress`);
        };
      },
      reconcile() {
        events.push(`${name}:reconcile`);
        if (++reconciled === 3) {
          ready.resolve();
        }
        return Promise.resolve();
      },
    },
    release() {
      events.push(`${name}:release`);
      return name === "lint" && releaseError ? Promise.reject(releaseError) : Promise.resolve();
    },
  });
  const spies = [
    spyOn(fs, "realpath").mockImplementation(((path) => Promise.resolve(String(path))) as typeof fs.realpath),
    spyOn(config, "loadConfig").mockResolvedValue({} as Awaited<ReturnType<typeof config.loadConfig>>),
    spyOn(packaging, "retainPackagingStructure").mockImplementation((root) => {
      events.push(`packaging:retain:${root}`);
      return Promise.resolve(() => {
        events.push(`packaging:release:${root}`);
        return Promise.resolve();
      });
    }),
    spyOn(packaging, "getPackagingStructure").mockImplementation((root) =>
      Promise.resolve({
        structure: { root, projects: [], workspaces: [], localDependencies: [] },
        cacheHit: true,
      } as unknown as packaging.PackagingResult),
    ),
    spyOn(precommit, "installPrecommit").mockImplementation(() => {
      events.push("precommit:install");
      return Promise.resolve({ status: "ready", message: "Ready" });
    }),
    spyOn(prepush, "installPrepush").mockImplementation(() => {
      events.push("prepush:install");
      return Promise.resolve({ status: "ready", message: "Ready" });
    }),
    spyOn(lint, "retainLintCoordinator").mockResolvedValue(
      owned("lint") as unknown as Awaited<ReturnType<typeof lint.retainLintCoordinator>>,
    ),
    spyOn(typecheck, "retainTypecheckCoordinator").mockResolvedValue(
      owned("typecheck") as unknown as Awaited<ReturnType<typeof typecheck.retainTypecheckCoordinator>>,
    ),
    spyOn(testing, "retainTestCoordinator").mockResolvedValue(
      owned("test") as unknown as Awaited<ReturnType<typeof testing.retainTestCoordinator>>,
    ),
  ];
  const api = {
    zod,
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getAllTools() {
      return [];
    },
  } as unknown as ExtensionAPI;
  registerInspection(api);
  const context = (root: string) =>
    ({
      cwd: root,
      hasUI: true,
      ui: {
        notify(message: string) {
          notices.push(message);
        },
      },
    }) as ExtensionContext;
  return {
    events,
    notices,
    ready: ready.promise,
    async emit(name: string, root = "/first") {
      for (const handler of handlers.get(name) ?? []) {
        await handler({} as never, context(root));
      }
    },
    inspect(root: string, signal?: AbortSignal) {
      const tool = tools.get("project_inspect");
      if (!tool) {
        throw new Error("Missing inspection tool");
      }
      return tool.execute("inspect", {}, signal, undefined, context(root));
    },
    tools,
    restore() {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}
