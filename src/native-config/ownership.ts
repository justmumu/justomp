/** Receipts describe prior managed fields; they never grant filesystem authority. */
export interface NativeConfigEntry {
  role: string;
  path: string;
  fields: string[][];
}
export interface NativeConfigOwnership {
  version: 1;
  configs: NativeConfigEntry[];
}
const ROLES = new Set([
  "biome",
  "prettier",
  "golangci",
  "ruff",
  "pyright",
  "typescript",
  "pytest",
  "coverage",
  "vitest",
  "bun",
]);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !["__proto__", "prototype", "constructor"].includes(value);
}
function localPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes(":") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
function validEntry(value: unknown): value is NativeConfigEntry {
  return (
    record(value) &&
    typeof value.role === "string" &&
    ROLES.has(value.role) &&
    localPath(value.path) &&
    Array.isArray(value.fields) &&
    value.fields.every((field: unknown) => Array.isArray(field) && field.length > 0 && field.every(safeKey))
  );
}
export function parseNativeOwnership(value: unknown): NativeConfigOwnership | undefined {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.configs) || !value.configs.every(validEntry)) {
    return undefined;
  }
  const configs = value.configs as NativeConfigEntry[];
  if (new Set(configs.map((config) => `${config.role}:${config.path}`)).size !== configs.length) {
    return undefined;
  }
  return {
    version: 1,
    configs: configs.map((config) => ({
      role: config.role,
      path: config.path,
      fields: config.fields.map((field) => [...field]),
    })),
  };
}
/** Invalid config metadata invalidates only readiness, never the selected tool versions. */
export function normalizeNativeOwnership(receipt: { ready: boolean; native_configs?: unknown }): void {
  if (receipt.native_configs === undefined) {
    return;
  }
  const metadata = parseNativeOwnership(receipt.native_configs);
  if (metadata) {
    receipt.native_configs = metadata;
  } else {
    receipt.native_configs = undefined;
    receipt.ready = false;
  }
}
function fieldValues(value: Record<string, unknown>, prefix: string[] = []): { path: string[]; value: unknown }[] {
  return Object.entries(value).flatMap(([key, item]) => {
    if (!safeKey(key)) {
      throw new Error(`Unsupported managed config key: ${key}`);
    }
    const path = [...prefix, key];
    return record(item) && Object.keys(item).length ? fieldValues(item, path) : [{ path, value: item }];
  });
}
function removeField(value: Record<string, unknown>, path: string[]): void {
  const [head, ...tail] = path;
  if (!head || !safeKey(head)) {
    return;
  }
  if (!tail.length) {
    delete value[head];
    return;
  }
  const child = value[head];
  if (record(child)) {
    removeField(child, tail);
    if (!Object.keys(child).length) {
      delete value[head];
    }
  }
}
function setField(value: Record<string, unknown>, path: string[], item: unknown): void {
  const [head, ...tail] = path;
  if (!head || !safeKey(head)) {
    throw new Error("Invalid managed config field");
  }
  if (!tail.length) {
    value[head] = structuredClone(item);
    return;
  }
  const child: Record<string, unknown> = record(value[head]) ? value[head] : {};
  value[head] = child;
  setField(child, tail, item);
}
/** Preserve project context while updating and retiring only known policy fields. */
export function reconcileFields(
  before: Record<string, unknown>,
  desired: Record<string, unknown>,
  previous: readonly string[][] = [],
): { value: Record<string, unknown>; fields: string[][] } {
  const value = structuredClone(before);
  const entries = fieldValues(desired);
  const fields = entries.map((entry) => entry.path);
  const retained = new Set(fields.map((field) => JSON.stringify(field)));
  for (const field of previous) {
    if (!retained.has(JSON.stringify(field))) {
      removeField(value, field);
    }
  }
  for (const entry of entries) {
    setField(value, entry.path, entry.value);
  }
  return { value, fields };
}
