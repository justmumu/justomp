import { join } from "node:path";
import { type FileSnapshot, readProjectionFile } from "../lint/files";
import { LintError } from "../lint/model";
import { configObject } from "./edit";
export const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];
export const GO_CONFIGS = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"];
export const PRETTIER_CONFIGS = [
  "package.json",
  "package.yaml",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  "prettier.config.js",
  ".prettierrc.ts",
  "prettier.config.ts",
  ".prettierrc.mjs",
  "prettier.config.mjs",
  ".prettierrc.mts",
  "prettier.config.mts",
  ".prettierrc.cjs",
  "prettier.config.cjs",
  ".prettierrc.cts",
  "prettier.config.cts",
  ".prettierrc.toml",
];
export interface NativeSelection {
  path: string;
  before: FileSnapshot;
  prefix: string[];
}
export async function selectNative(
  root: string,
  cwd: string,
  names: string[],
  fallback: string,
  ambiguous = true,
): Promise<NativeSelection> {
  const matches: NativeSelection[] = [];
  for (const name of names) {
    const path = join(cwd, name),
      before = await readProjectionFile(root, path);
    if (before.text !== null) {
      matches.push({ path, before, prefix: [] });
    }
  }
  if (ambiguous && matches.length > 1) {
    throw new LintError(
      "projection-conflict",
      `Ambiguous native configuration: ${matches.map((match) => match.path).join(", ")}`,
    );
  }
  const found = matches[0];
  return (
    found ?? { path: join(cwd, fallback), before: await readProjectionFile(root, join(cwd, fallback)), prefix: [] }
  );
}
function prettierPrefix(name: string, text: string, path: string): string[] | undefined {
  if (!name.startsWith("package.")) {
    return [];
  }
  const embedded = configObject(text, path).prettier;
  if (embedded === undefined) {
    return undefined;
  }
  if (!embedded || typeof embedded !== "object" || Array.isArray(embedded)) {
    throw new LintError(
      "unsupported-config",
      `External or dynamic Prettier configuration cannot be statically edited: ${path}`,
    );
  }
  return ["prettier"];
}
export async function selectPrettier(root: string, cwd: string): Promise<NativeSelection> {
  for (const name of PRETTIER_CONFIGS) {
    const path = join(cwd, name),
      before = await readProjectionFile(root, path);
    if (before.text === null) {
      continue;
    }
    const prefix = prettierPrefix(name, before.text, path);
    if (prefix) {
      return { path, before, prefix };
    }
  }
  const path = join(cwd, ".prettierrc.json");
  return { path, before: await readProjectionFile(root, path), prefix: [] };
}
