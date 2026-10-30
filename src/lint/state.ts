import { join } from "node:path";
import type { ToolVersions } from "./adapters/types";
import {
  type FileSnapshot,
  publishProjectionFile,
  readProjectionFile,
} from "./files";
import { type LintEcosystem, LintError } from "./model";
import { validateToolVersions } from "./versions";

export interface ProjectReceipt {
  ecosystem: LintEcosystem;
  tools: ToolVersions;
  policy_hash: string;
  ready: boolean;
}
export interface LintState {
  schema: 1;
  projects: Record<string, ProjectReceipt>;
  python?: { projects: string[]; tools: ToolVersions; complete: boolean };
}
function emptyState(): LintState {
  return { schema: 1, projects: {} };
}
function parseState(text: string): LintState {
  const state = JSON.parse(text) as LintState;
  if (
    state?.schema !== 1 ||
    !state.projects ||
    typeof state.projects !== "object" ||
    Array.isArray(state.projects)
  )
    throw new Error("Invalid lint state schema");
  for (const [id, receipt] of Object.entries(state.projects)) {
    if (
      !receipt ||
      !["python", "javascript", "go"].includes(receipt.ecosystem) ||
      !id.startsWith(`${receipt.ecosystem}:`) ||
      typeof receipt.ready !== "boolean" ||
      typeof receipt.policy_hash !== "string"
    )
      throw new Error("Invalid lint receipt");
    validateToolVersions(receipt.tools);
  }
  if (state.python) {
    if (
      !Array.isArray(state.python.projects) ||
      !state.python.projects.every(
        (id) => typeof id === "string" && id.startsWith("python:"),
      ) ||
      typeof state.python.complete !== "boolean"
    )
      throw new Error("Invalid Python wave");
    validateToolVersions(state.python.tools);
  }
  return state;
}
/** Durable receipts and resolved targets; never a persisted lock or busy marker. */
export class LintStateStore {
  private constructor(
    readonly root: string,
    public state: LintState,
    private snapshot: FileSnapshot,
    readonly recovery?: string,
  ) {}
  static async load(root: string): Promise<LintStateStore> {
    const snapshot = await readProjectionFile(
      root,
      join(root, ".justomp/lint_state.json"),
    );
    if (snapshot.text === null)
      return new LintStateStore(root, emptyState(), snapshot);
    try {
      return new LintStateStore(root, parseState(snapshot.text), snapshot);
    } catch {
      return new LintStateStore(
        root,
        emptyState(),
        snapshot,
        "Invalid lint state was discarded; all native readiness must be verified again",
      );
    }
  }
  async save(): Promise<void> {
    const content = `${JSON.stringify(this.state, null, 2)}\n`;
    if (content === this.snapshot.text) return;
    try {
      await publishProjectionFile(
        this.root,
        join(this.root, ".justomp/lint_state.json"),
        this.snapshot,
        content,
      );
    } catch (error) {
      throw new LintError(
        "state-conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
    this.snapshot = await readProjectionFile(
      this.root,
      join(this.root, ".justomp/lint_state.json"),
    );
    if (this.snapshot.text !== content)
      throw new LintError(
        "state-conflict",
        "Lint state changed immediately after publication",
      );
  }
}
