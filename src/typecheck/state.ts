import { join } from "node:path";
import {
  type FileSnapshot,
  publishProjectionFile,
  readProjectionFile,
} from "../lint/files";
import type { ToolVersions } from "./adapters/types";
import { type TypecheckEcosystem, TypecheckError } from "./model";
import { validateToolVersions } from "./versions";

export interface ProjectReceipt {
  ecosystem: TypecheckEcosystem;
  tools: ToolVersions;
  policy_hash: string;
  ready: boolean;
}
export interface VersionWave {
  projects: string[];
  tools: ToolVersions;
  complete: boolean;
  pending: string[];
}
export interface NextTypeInputs {
  config: string;
  dist: string;
}
export interface GeneratedTypeReceipt {
  ready: boolean;
  project_ids: string[];
  input_hash: string;
  outputs: Record<string, string>;
  declarations?: Record<string, string>;
  next: Record<string, NextTypeInputs>;
}
export interface TypecheckState {
  schema: 1;
  generated?: Record<string, GeneratedTypeReceipt>;
  projects: Record<string, ProjectReceipt>;
  waves: Partial<Record<"python" | "javascript", VersionWave>>;
}
function emptyState(): TypecheckState {
  return { schema: 1, projects: {}, waves: {} };
}
function parseState(text: string): TypecheckState {
  const state = JSON.parse(text) as TypecheckState;
  if (
    state?.schema !== 1 ||
    !state.projects ||
    typeof state.projects !== "object" ||
    Array.isArray(state.projects)
  )
    throw new Error("Invalid typecheck state schema");
  for (const [id, receipt] of Object.entries(state.projects)) {
    if (
      !receipt ||
      !["python", "javascript", "go"].includes(receipt.ecosystem) ||
      !id.startsWith(`${receipt.ecosystem}:`) ||
      typeof receipt.ready !== "boolean" ||
      typeof receipt.policy_hash !== "string"
    )
      throw new Error("Invalid typecheck receipt");
    validateToolVersions(receipt.tools);
  }
  if (
    !state.waves ||
    typeof state.waves !== "object" ||
    Array.isArray(state.waves)
  )
    throw new Error("Invalid wave map");
  for (const [ecosystem, wave] of Object.entries(state.waves)) {
    if (
      !["python", "javascript"].includes(ecosystem) ||
      !wave ||
      typeof wave.complete !== "boolean" ||
      !Array.isArray(wave.projects) ||
      !Array.isArray(wave.pending) ||
      ![...wave.projects, ...wave.pending].every(
        (id) => typeof id === "string" && id.startsWith(`${ecosystem}:`),
      )
    )
      throw new Error("Invalid typecheck wave");
    validateToolVersions(wave.tools);
  }
  if (state.generated !== undefined) {
    if (
      !state.generated ||
      typeof state.generated !== "object" ||
      Array.isArray(state.generated)
    )
      throw new Error("Invalid generated type receipts");
    for (const receipt of Object.values(state.generated)) {
      if (
        !receipt ||
        typeof receipt.ready !== "boolean" ||
        typeof receipt.input_hash !== "string" ||
        !Array.isArray(receipt.project_ids) ||
        !receipt.project_ids.every((id) => typeof id === "string") ||
        !receipt.outputs ||
        typeof receipt.outputs !== "object" ||
        !Object.values(receipt.outputs).every(
          (hash) => typeof hash === "string",
        ) ||
        (receipt.declarations !== undefined &&
          (!receipt.declarations ||
            typeof receipt.declarations !== "object" ||
            !Object.values(receipt.declarations).every(
              (path) => typeof path === "string",
            ))) ||
        !receipt.next ||
        typeof receipt.next !== "object" ||
        !Object.values(receipt.next).every(
          (value) =>
            value &&
            typeof value.config === "string" &&
            typeof value.dist === "string",
        )
      )
        throw new Error("Invalid generated type receipt");
    }
  }
  return state;
}
/** Durable receipts and resolved targets; never a persisted lock or busy marker. */
export class TypecheckStateStore {
  private constructor(
    readonly root: string,
    public state: TypecheckState,
    private snapshot: FileSnapshot,
    readonly recovery?: string,
  ) {}
  static async load(root: string): Promise<TypecheckStateStore> {
    const snapshot = await readProjectionFile(
      root,
      join(root, ".justomp/typecheck_state.json"),
    );
    if (snapshot.text === null)
      return new TypecheckStateStore(root, emptyState(), snapshot);
    try {
      return new TypecheckStateStore(root, parseState(snapshot.text), snapshot);
    } catch {
      return new TypecheckStateStore(
        root,
        emptyState(),
        snapshot,
        "Invalid typecheck state was discarded; all native readiness must be verified again",
      );
    }
  }
  async save(): Promise<void> {
    const content = `${JSON.stringify(this.state, null, 2)}\n`;
    if (content === this.snapshot.text) return;
    try {
      await publishProjectionFile(
        this.root,
        join(this.root, ".justomp/typecheck_state.json"),
        this.snapshot,
        content,
      );
    } catch (error) {
      throw new TypecheckError(
        "state-conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
    this.snapshot = await readProjectionFile(
      this.root,
      join(this.root, ".justomp/typecheck_state.json"),
    );
    if (this.snapshot.text !== content)
      throw new TypecheckError(
        "state-conflict",
        "Typecheck state changed immediately after publication",
      );
  }
}
