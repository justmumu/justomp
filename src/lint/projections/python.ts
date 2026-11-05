import { parse } from "smol-toml";
import { type PythonPolicy } from "../../config/lint/model";
import { LintError } from "../model";

const PROJECT_FIELDS = new Set(["src", "target-version"]);

export interface Statement {
  text: string;
  path?: string[];
  table?: boolean;
}
function keyPath(key: string): string[] {
  let node: unknown = parse(`${key} = 0`);
  const path: string[] = [];
  while (node && typeof node === "object") {
    const entry = Object.entries(node)[0];
    if (!entry) {
      break;
    }
    path.push(entry[0]);
    node = entry[1];
  }
  return path;
}
function advanceQuote(text: string, index: number, quote: string): { index: number; quote: string } {
  const char = text[index];
  if (char === "\\" && quote === '"') {
    index++;
  } else if (char === quote) {
    quote = "";
  }
  return { index, quote };
}
function quotedKeyEnd(text: string, start: number, delimiter: string): number {
  let quote = "";
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (!quote) {
      if (char === delimiter) {
        return index;
      }
      if (char === '"' || char === "'") {
        quote = char;
      }
      continue;
    }
    const quoted = advanceQuote(text, index, quote);
    index = quoted.index;
    quote = quoted.quote;
  }
  return text.length;
}
function assignmentKey(text: string): string {
  const end = quotedKeyEnd(text, 0, "=");
  if (end === text.length) {
    throw new LintError("invalid-config", "Invalid TOML assignment");
  }
  return text.slice(0, end).trim();
}
function completeStatement(lines: string[], start: number): { value: string; index: number } {
  let value = lines[start] as string;
  let index = start;
  for (;;) {
    try {
      parse(value);
      return { value, index };
    } catch (error) {
      if (++index >= lines.length) {
        throw error;
      }
      value += lines[index];
    }
  }
}
function tablePath(value: string): string[] {
  const start = value.indexOf("[") + (value.trimStart().startsWith("[[") ? 2 : 1);
  return keyPath(value.slice(start, quotedKeyEnd(value, start, "]")));
}
/** Parse complete statements, so header-like text in multiline strings is inert. */
export function statements(text: string): Statement[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: Statement[] = [];
  let section: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    let value = lines[index] as string;
    if (/^(?:#.*)?$/.test(value.trim())) {
      result.push({ text: value });
      continue;
    }
    const table = value.trimStart().startsWith("[");
    const complete = completeStatement(lines, index);
    value = complete.value;
    index = complete.index;
    if (table) {
      section = tablePath(value);
      result.push({ text: value, path: section, table: true });
    } else {
      result.push({
        text: value,
        path: [...section, ...keyPath(assignmentKey(value))],
      });
    }
  }
  return result;
}
function tomlValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(tomlValue).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`)
      .join(", ")} }`;
  }
  throw new LintError("invalid-config", "Ruff policy contains a value TOML cannot represent");
}
function isRuff(path: string[]): boolean {
  return path[0] === "tool" && path[1] === "ruff";
}
function validateRuffContainer(
  path: string[],
  parsed: Record<string, unknown>,
  rootTable: Statement | undefined,
  owned: Set<string>,
): void {
  if (
    path[0] === "tool" &&
    path.length < 3 &&
    (parsed.tool as Record<string, unknown> | undefined)?.ruff !== undefined
  ) {
    throw new LintError(
      "unsupported-config",
      "Inline tool/ruff tables require expanded [tool.ruff] configuration before projection",
    );
  }
  if (!rootTable && isRuff(path) && !owned.has(path[2] ?? "")) {
    throw new LintError(
      "unsupported-config",
      "Dotted Ruff configuration requires an explicit [tool.ruff] table before projection",
    );
  }
}
function validateRuffContainers(
  parts: Statement[],
  parsed: Record<string, unknown>,
  rootTable: Statement | undefined,
  owned: Set<string>,
): void {
  // Inline/dotted ancestor containers cannot be split without rewriting unrelated values.
  for (const part of parts) {
    if (!part.path || part.table) {
      continue;
    }
    validateRuffContainer(part.path, parsed, rootTable, owned);
  }
}
function validateLocalRuff(
  parts: Statement[],
  parsed: Record<string, unknown>,
  rootTable: Statement | undefined,
  owned: Set<string>,
): void {
  validateRuffContainers(parts, parsed, rootTable, owned);
  const local = (parsed.tool as { ruff?: Record<string, unknown> } | undefined)?.ruff;
  for (const field of Object.keys(local ?? {})) {
    if (!owned.has(field) && !PROJECT_FIELDS.has(field)) {
      throw new LintError(
        "config-conflict",
        `Project-local Ruff option "${field}" is absent from the shared policy; move it to lint.python.ruff in the root .justomp/config.json or remove it from this pyproject.toml`,
      );
    }
  }
}
function ownedStatement(part: Statement, owned: Set<string>): boolean {
  return part.path !== undefined && isRuff(part.path) && owned.has(part.path[2] ?? "");
}
function renderRuffStatement(
  part: Statement,
  rootTable: Statement | undefined,
  owned: Set<string>,
  replacement: string,
  eol: string,
): string {
  if (part === rootTable) {
    return part.text + (part.text.endsWith("\n") ? "" : eol) + replacement;
  }
  if (ownedStatement(part, owned)) {
    return "";
  }
  return part.text;
}
function replaceRuff(
  parts: Statement[],
  rootTable: Statement | undefined,
  owned: Set<string>,
  replacement: string,
  eol: string,
): string {
  let output = parts.map((part) => renderRuffStatement(part, rootTable, owned, replacement, eol)).join("");
  if (!rootTable) {
    output += `${output && !output.endsWith("\n") ? eol : ""}[tool.ruff]${eol}${replacement}`;
  }
  return output;
}
/** Replace policy-owned Ruff fields only; every other statement retains its bytes. */
export function projectPython(
  before: string,
  policy: PythonPolicy,
  previouslyOwned: ReadonlySet<string> = new Set(),
): string {
  const parsed = parse(before);
  const parts = statements(before);
  const owned = new Set([...Object.keys(policy.ruff), ...previouslyOwned]);
  const rootTable = parts.find((part) => part.table && part.path?.length === 2 && isRuff(part.path));
  validateLocalRuff(parts, parsed, rootTable, owned);
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const replacement = Object.entries(policy.ruff)
    .map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}${eol}`)
    .join("");
  const output = replaceRuff(parts, rootTable, owned, replacement, eol);
  // Native syntax validation is also a postcondition for unusual quoted/dotted keys.
  parse(output);
  return output;
}
