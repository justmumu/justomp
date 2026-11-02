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
function stateRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}
function ecosystemName(value: unknown): value is LintEcosystem {
  return value === "python" || value === "javascript" || value === "go";
}
function parseReceipt(value: unknown, id: string, schema: number): ProjectReceipt {
  const receipt = stateRecord(value, "Invalid lint receipt");
  if (
    !ecosystemName(receipt.ecosystem) ||
    !id.startsWith(`${receipt.ecosystem}:`) ||
    typeof receipt.ready !== "boolean" ||
    typeof receipt.policy_hash !== "string"
  ) {
    throw new Error("Invalid lint receipt");
  }
  validateSelection(receipt.tools, receipt.ecosystem === "javascript" && !receipt.ready);
  const tools = receipt.tools as ToolVersions;
  const parsed = {
    ...receipt,
    ecosystem: receipt.ecosystem,
    ready: receipt.ready,
    policy_hash: receipt.policy_hash,
    tools,
  };
  if (parsed.ecosystem === "javascript") {
    parsed.tools = nativeJavascriptTools(tools);
    if (schema !== 3 || !Object.keys(parsed.tools).length) {
      parsed.ready = false;
    }
  }
  return parsed;
}
function waveProjects(value: unknown, ecosystem: string, message: string): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.startsWith(`${ecosystem}:`))) {
    throw new Error(message);
  }
  return value as string[];
}
function legacyPython(value: unknown): LegacyLintState["python"] {
  if (!value) {
    return undefined;
  }
  const wave = stateRecord(value, "Invalid Python wave");
  const projects = waveProjects(wave.projects, "python", "Invalid Python wave");
  if (typeof wave.complete !== "boolean") {
    throw new Error("Invalid Python wave");
  }
  const tools = validateToolVersions(wave.tools);
  return { projects, tools, complete: wave.complete };
}
function migrateLegacy(projects: Record<string, ProjectReceipt>, python: LegacyLintState["python"]): LintState {
  const migrated: LintState = { schema: 3, projects, waves: {} };
  for (const ecosystem of ["python", "javascript", "go"] as const) {
    const members = Object.keys(projects)
      .filter((id) => projects[id]?.ecosystem === ecosystem)
      .sort();
    const legacy = ecosystem === "python" ? python : undefined;
    if (!members.length && !legacy) {
      continue;
    }
    const ids = legacy?.projects ?? members;
    migrated.waves[ecosystem] = {
      projects: ids,
      versions: Object.fromEntries(ids.map((id) => [id, { ...(legacy?.tools ?? projects[id]?.tools ?? {}) }])),
      complete: legacy?.complete ?? members.every((id) => projects[id]?.ready),
    };
  }
  if (migrated.waves.javascript) {
    migrated.waves.javascript.complete = false;
  }
  return migrated;
}
function normalizeWaveVersions(
  projects: string[],
  versions: Record<string, ToolVersions>,
  rawVersions: Record<string, unknown>,
  ecosystem: string,
  schema: number,
  complete: boolean,
): boolean {
  for (const id of projects) {
    validateSelection(rawVersions[id], ecosystem === "javascript" && !complete);
    if (ecosystem === "javascript") {
      versions[id] = nativeJavascriptTools(versions[id] ?? {});
      if (schema !== 3 || !Object.keys(versions[id]).length) {
        complete = false;
      }
    }
  }
  return complete;
}
function parseWave(value: unknown, ecosystem: string, schema: number): LintWave {
  const wave = stateRecord(value, "Invalid lint wave");
  if (!ecosystemName(ecosystem) || typeof wave.complete !== "boolean") {
    throw new Error("Invalid lint wave");
  }
  const projects = waveProjects(wave.projects, ecosystem, "Invalid lint wave");
  const rawVersions = stateRecord(wave.versions, "Invalid lint wave");
  const versions = { ...rawVersions } as Record<string, ToolVersions>;
  let complete = wave.complete;
  complete = normalizeWaveVersions(projects, versions, rawVersions, ecosystem, schema, complete);
  return { ...wave, projects, versions, complete };
}
function parseState(text: string): LintState {
  const state = stateRecord(JSON.parse(text), "Invalid lint state schema");
  if (state.schema !== 1 && state.schema !== 2 && state.schema !== 3) {
    throw new Error("Invalid lint state schema");
  }
  const schema = state.schema;
  const projects = Object.fromEntries(
    Object.entries(stateRecord(state.projects, "Invalid lint state schema")).map(([id, receipt]) => [
      id,
      parseReceipt(receipt, id, schema),
    ]),
  );
  if (schema === 1) {
    return migrateLegacy(projects, legacyPython(state.python));
  }
  const waves = Object.fromEntries(
    Object.entries(stateRecord(state.waves, "Invalid lint waves")).map(([ecosystem, wave]) => [
      ecosystem,
      parseWave(wave, ecosystem, schema),
    ]),
  );
  return { ...state, schema: 3, projects, waves };
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
    } catch (error: unknown) {
      throw new LintError("state-conflict", String(error instanceof Error ? error.message : error));
    }
    this.snapshot = await readProjectionFile(this.root, join(this.root, ".justomp/lint_state.json"));
    if (this.snapshot.text !== content) {
      throw new LintError("state-conflict", "Lint state changed immediately after publication");
    }
  }
}
