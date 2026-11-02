import { join } from "node:path";
import { type FileSnapshot, publishProjectionFile, readProjectionFile } from "../lint/files";
import { toolMembership } from "../packaging/tool-membership";
import { type TestTools } from "./adapters";
import { TestError, type TestRunner } from "./model";
export interface TestWave {
  projects: string[];
  tools: TestTools;
  complete: boolean;
  pending: string[];
}
export interface TestReceipt {
  runner: TestRunner;
  tools: TestTools;
  policy_hash: string;
  ready: boolean;
}
export interface TestState {
  schema: 1;
  projects: Record<string, TestReceipt>;
  waves: Partial<Record<TestRunner, TestWave>>;
}
export function nextWave(previous: TestWave | undefined, projects: string[]) {
  return toolMembership(previous, projects);
}
function validTools(value: unknown): value is TestTools {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((v) => typeof v === "string" && /^\d+\.\d+(?:\.\d+)?$/.test(v))
  );
}
export class TestStateStore {
  private constructor(
    readonly root: string,
    public state: TestState,
    private snapshot: FileSnapshot,
    readonly recovery?: string,
  ) {}
  static async load(root: string): Promise<TestStateStore> {
    const snapshot = await readProjectionFile(root, join(root, ".justomp/test_state.json"));
    const empty: TestState = { schema: 1, projects: {}, waves: {} };
    if (snapshot.text === null) {
      return new TestStateStore(root, empty, snapshot);
    }
    try {
      const state = JSON.parse(snapshot.text) as TestState;
      if (
        state.schema !== 1 ||
        !state.projects ||
        Array.isArray(state.projects) ||
        !state.waves ||
        Array.isArray(state.waves)
      ) {
        throw new Error("schema");
      }
      for (const item of Object.values(state.projects)) {
        if (
          !item ||
          !["pytest", "vitest", "bun", "go"].includes(item.runner) ||
          !validTools(item.tools) ||
          typeof item.ready !== "boolean" ||
          typeof item.policy_hash !== "string"
        ) {
          throw new Error("receipt");
        }
      }
      for (const [name, wave] of Object.entries(state.waves)) {
        if (
          !["pytest", "vitest", "bun", "go"].includes(name) ||
          !wave ||
          !validTools(wave.tools) ||
          typeof wave.complete !== "boolean" ||
          !Array.isArray(wave.projects) ||
          !Array.isArray(wave.pending) ||
          ![...wave.projects, ...wave.pending].every((v) => typeof v === "string")
        ) {
          throw new Error("wave");
        }
      }
      return new TestStateStore(root, state, snapshot);
    } catch {
      return new TestStateStore(
        root,
        empty,
        snapshot,
        "Invalid test receipts discarded; native readiness will be reverified",
      );
    }
  }
  async save(): Promise<void> {
    const content = `${JSON.stringify(this.state, null, 2)}\n`;
    if (content === this.snapshot.text) {
      return;
    }
    await publishProjectionFile(this.root, join(this.root, ".justomp/test_state.json"), this.snapshot, content);
    this.snapshot = await readProjectionFile(this.root, join(this.root, ".justomp/test_state.json"));
    if (this.snapshot.text !== content) {
      throw new TestError("state-conflict", "Test state changed during publication");
    }
  }
}
