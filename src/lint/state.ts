import { join } from "node:path";
import { type ToolVersions } from "./adapters/types";
import { type FileSnapshot, publishProjectionFile, readProjectionFile } from "./files";
import { nativeJavascriptTools } from "./javascript/tools";
import { type LintEcosystem, LintError } from "./model";
import { sameVersions, validateToolVersions } from "./versions";

export interface ProjectReceipt {
  ecosystem: LintEcosystem;
  tools: ToolVersions;
  policy_hash: string;
  ready: boolean;
}
export interface LintWave {
  projects: string[];
  versions: Record<string, ToolVersions>;
  complete: boolean;
}
export interface LintState {
  schema: 3;
  projects: Record<string, ProjectReceipt>;
  waves: Partial<Record<LintEcosystem, LintWave>>;
}
interface LegacyLintState {
  schema: 1;
  projects: Record<string, ProjectReceipt>;
  python?: { projects: string[]; tools: ToolVersions; complete: boolean };
}
export function lintWaveReady(state: LintState, ecosystem: LintEcosystem, ids: string[]): boolean {
  const wave = state.waves[ecosystem];
  return (
    !!wave?.complete &&
    JSON.stringify([...wave.projects].sort()) === JSON.stringify([...ids].sort()) &&
    ids.every((id) => {
      const receipt = state.projects[id];
      return receipt?.ready && !!wave.versions[id] && sameVersions(wave.versions[id], receipt.tools);
    })
  );
}
function emptyState(): LintState {
  return { schema: 3, projects: {}, waves: {} };
}
/** An empty JavaScript selection is the durable, unprepared engine-migration state. */
function validateSelection(value: unknown, unpreparedJavascript: boolean): void {
  if (
    unpreparedJavascript &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return;
  }
  validateToolVersions(value);
}
function parseState(text: string): LintState {
  const state = JSON.parse(text) as LintState | LegacyLintState | (Omit<LintState, "schema"> & { schema: 2 });
  if (
    (state?.schema !== 1 && state?.schema !== 2 && state?.schema !== 3) ||
    !state.projects ||
    typeof state.projects !== "object" ||
    Array.isArray(state.projects)
  ) {
    throw new Error("Invalid lint state schema");
  }
  for (const [id, receipt] of Object.entries(state.projects)) {
    if (
      !receipt ||
      !["python", "javascript", "go"].includes(receipt.ecosystem) ||
      !id.startsWith(`${receipt.ecosystem}:`) ||
      typeof receipt.ready !== "boolean" ||
      typeof receipt.policy_hash !== "string"
    ) {
      throw new Error("Invalid lint receipt");
    }
    validateSelection(receipt.tools, receipt.ecosystem === "javascript" && !receipt.ready);
    if (receipt.ecosystem === "javascript") {
      receipt.tools = nativeJavascriptTools(receipt.tools);
      if (state.schema !== 3 || !Object.keys(receipt.tools).length) {
        receipt.ready = false;
      }
    }
  }
  if (state.schema === 1 && state.python) {
    if (
      !Array.isArray(state.python.projects) ||
      !state.python.projects.every((id) => typeof id === "string" && id.startsWith("python:")) ||
      typeof state.python.complete !== "boolean"
    ) {
      throw new Error("Invalid Python wave");
    }
    validateToolVersions(state.python.tools);
  }
  if (state.schema === 1) {
    const migrated: LintState = {
      schema: 3,
      projects: state.projects,
      waves: {},
    };
    for (const ecosystem of ["python", "javascript", "go"] as const) {
      const projects = Object.keys(state.projects)
        .filter((id) => state.projects[id]?.ecosystem === ecosystem)
        .sort();
      const legacy = ecosystem === "python" ? state.python : undefined;
      if (!projects.length && !legacy) {
        continue;
      }
      const ids = legacy?.projects ?? projects;
      migrated.waves[ecosystem] = {
        projects: ids,
        versions: Object.fromEntries(ids.map((id) => [id, { ...(legacy?.tools ?? state.projects[id]?.tools ?? {}) }])),
        complete: legacy?.complete ?? projects.every((id) => state.projects[id]?.ready),
      };
    }
    if (migrated.waves.javascript) {
      migrated.waves.javascript.complete = false;
    }
    return migrated;
  }
  if (!state.waves || typeof state.waves !== "object" || Array.isArray(state.waves)) {
    throw new Error("Invalid lint waves");
  }
  for (const [ecosystem, wave] of Object.entries(state.waves)) {
    if (
      !["python", "javascript", "go"].includes(ecosystem) ||
      !wave ||
      !Array.isArray(wave.projects) ||
      !wave.projects.every((id) => typeof id === "string" && id.startsWith(`${ecosystem}:`)) ||
      typeof wave.complete !== "boolean" ||
      !wave.versions ||
      typeof wave.versions !== "object" ||
      Array.isArray(wave.versions)
    ) {
      throw new Error("Invalid lint wave");
    }
    for (const id of wave.projects) {
      validateSelection(wave.versions[id], ecosystem === "javascript" && !wave.complete);
      if (ecosystem === "javascript") {
        wave.versions[id] = nativeJavascriptTools(wave.versions[id] ?? {});
        if (state.schema !== 3 || !Object.keys(wave.versions[id]).length) {
          wave.complete = false;
        }
      }
    }
  }
  return { ...state, schema: 3 };
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
    const snapshot = await readProjectionFile(root, join(root, ".justomp/lint_state.json"));
    if (snapshot.text === null) {
      return new LintStateStore(root, emptyState(), snapshot);
    }
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
    if (content === this.snapshot.text) {
      return;
    }
    try {
      await publishProjectionFile(this.root, join(this.root, ".justomp/lint_state.json"), this.snapshot, content);
    } catch (error) {
      throw new LintError("state-conflict", error instanceof Error ? error.message : String(error));
    }
    this.snapshot = await readProjectionFile(this.root, join(this.root, ".justomp/lint_state.json"));
    if (this.snapshot.text !== content) {
      throw new LintError("state-conflict", "Lint state changed immediately after publication");
    }
  }
}
