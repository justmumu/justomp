import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { FSWatcher } from "chokidar";
import * as config from "../../../src/config/load";
import * as packaging from "../../../src/packaging/get-structure";
import { type PreparationReport } from "../../../src/typecheck/prepare";

/** Supply external observations; the real coordinator owns scheduling and publication. */
export function coordinatorPorts() {
  const events: string[] = [];
  const subscriptions = new Map<string, () => void>();
  const watchers: FSWatcher[] = [];
  const policy = { lintKey: "first", typecheckKey: "first", testingKey: "first" };
  const metadata = { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, mode: 1 };
  const spies = [
    spyOn(fs, "realpath").mockImplementation(((path) => Promise.resolve(String(path))) as typeof fs.realpath),
    spyOn(fs, "lstat").mockResolvedValue(metadata as Awaited<ReturnType<typeof fs.lstat>>),
    spyOn(config, "loadConfig").mockResolvedValue(policy as config.LoadedConfig),
    spyOn(packaging, "getPackagingStructure").mockImplementation((root) =>
      Promise.resolve({ structure: { root, projects: [] } } as unknown as packaging.PackagingResult),
    ),
    spyOn(packaging, "retainPackagingStructure").mockImplementation((root) => {
      events.push(`retain:${root}`);
      return Promise.resolve(() => {
        events.push(`release:${root}`);
        return Promise.resolve();
      });
    }),
    spyOn(packaging, "subscribePackagingStructure").mockImplementation((root, listener) => {
      subscriptions.set(root, listener);
      return Promise.resolve(() => {
        events.push(`unsubscribe:${root}`);
      });
    }),
    spyOn(FSWatcher.prototype, "add").mockImplementation(function (this: FSWatcher) {
      watchers.push(this);
      return this;
    }),
    spyOn(FSWatcher.prototype, "close").mockImplementation(() => {
      events.push("watcher:close");
      return Promise.resolve();
    }),
  ];
  return {
    events,
    policy,
    metadata,
    watchers,
    notify(root = "/coordinator") {
      const listener = subscriptions.get(root);
      if (!listener) {
        throw new Error(`Missing packaging subscription: ${root}`);
      }
      listener();
    },
    restore() {
      for (const spy of spies.reverse()) {
        spy.mockRestore();
      }
    },
  };
}

export function preparation(overrides: Partial<PreparationReport> = {}): PreparationReport {
  return {
    status: "ready",
    action: "already-ready",
    tools: {},
    affected_projects: [],
    changes: [],
    diagnostics: [],
    complete: true,
    cancelled: false,
    errors: [],
    projects: {},
    ...overrides,
  };
}

export function blockedPass() {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<PreparationReport>();
  return { started, result };
}
