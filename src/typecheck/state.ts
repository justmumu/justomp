import { join } from "node:path";
import { type FileSnapshot, publishProjectionFile, readProjectionFile } from "../lint/files";
import { type NativeConfigOwnership, normalizeNativeOwnership } from "../native-config/ownership";
import { type ToolVersions } from "./adapters/types";
import { type TypecheckEcosystem, TypecheckError } from "./model";
import { validateToolVersions } from "./versions";

export interface ProjectReceipt {
  native_configs?: NativeConfigOwnership;
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
function dataObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
function validStringValues(value: unknown): boolean {
  const data = dataObject(value);
  return data !== undefined && Object.values(data).every((item) => typeof item === "string");
}
function validateReceipt(id: string, value: unknown): void {
  const receipt = dataObject(value);
  if (
    !receipt ||
    typeof receipt.ecosystem !== "string" ||
    !["python", "javascript", "go"].includes(receipt.ecosystem) ||
    !id.startsWith(`${receipt.ecosystem}:`) ||
    typeof receipt.ready !== "boolean" ||
    typeof receipt.policy_hash !== "string"
  ) {
    throw new Error("Invalid typecheck receipt");
  }
  validateToolVersions(receipt.tools);
  normalizeNativeOwnership(receipt as { ready: boolean; native_configs?: unknown });
}
function validateWave(ecosystem: string, value: unknown): void {
  const wave = dataObject(value);
  if (
    !["python", "javascript"].includes(ecosystem) ||
    !wave ||
    typeof wave.complete !== "boolean" ||
    !Array.isArray(wave.projects) ||
    !Array.isArray(wave.pending) ||
    ![...wave.projects, ...wave.pending].every((id) => typeof id === "string" && id.startsWith(`${ecosystem}:`))
  ) {
    throw new Error("Invalid typecheck wave");
  }
  validateToolVersions(wave.tools);
}
function validNext(value: unknown): boolean {
  const next = dataObject(value);
  return (
    next !== undefined &&
    Object.values(next).every((item) => {
      const data = dataObject(item);
      return data !== undefined && typeof data.config === "string" && typeof data.dist === "string";
    })
  );
}
function validateGenerated(value: unknown): void {
  const receipt = dataObject(value);
  if (
    !receipt ||
    typeof receipt.ready !== "boolean" ||
    typeof receipt.input_hash !== "string" ||
    !Array.isArray(receipt.project_ids) ||
    !receipt.project_ids.every((id) => typeof id === "string") ||
    !validStringValues(receipt.outputs) ||
    !validNext(receipt.next)
  ) {
    throw new Error("Invalid generated type receipt");
  }
}
function validateGeneratedMap(value: unknown): void {
  if (value === undefined) {
    return;
  }
  const generated = dataObject(value);
  if (!generated || Array.isArray(value)) {
    throw new Error("Invalid generated type receipts");
  }
  for (const receipt of Object.values(generated)) {
    validateGenerated(receipt);
  }
}
function parseState(text: string): TypecheckState {
  const parsed: unknown = JSON.parse(text);
  const state = dataObject(parsed);
  const projects = dataObject(state?.projects);
  if (state?.schema !== 1 || !projects || Array.isArray(state.projects)) {
    throw new Error("Invalid typecheck state schema");
  }
  for (const [id, receipt] of Object.entries(projects)) {
    validateReceipt(id, receipt);
  }
  const waves = dataObject(state.waves);
  if (!waves || Array.isArray(state.waves)) {
    throw new Error("Invalid wave map");
  }
  for (const [ecosystem, wave] of Object.entries(waves)) {
    validateWave(ecosystem, wave);
  }
  validateGeneratedMap(state.generated);
  return parsed as TypecheckState;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    const snapshot = await readProjectionFile(root, join(root, ".justomp/typecheck_state.json"));
    if (snapshot.text === null) {
      return new TypecheckStateStore(root, emptyState(), snapshot);
    }
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
    if (content === this.snapshot.text) {
      return;
    }
    try {
      await publishProjectionFile(this.root, join(this.root, ".justomp/typecheck_state.json"), this.snapshot, content);
    } catch (error) {
      throw new TypecheckError("state-conflict", errorMessage(error));
    }
    this.snapshot = await readProjectionFile(this.root, join(this.root, ".justomp/typecheck_state.json"));
    if (this.snapshot.text !== content) {
      throw new TypecheckError("state-conflict", "Typecheck state changed immediately after publication");
    }
  }
}
