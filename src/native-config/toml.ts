import { parse } from "smol-toml";
import { LintError } from "../lint/model";
import { type Statement, statements } from "../lint/projections/python";
import { valueAt } from "./values";

function literal(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(literal).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${literal(item)}`)
      .join(", ")} }`;
  }
  throw new LintError("unsupported-config", "Native TOML policy contains an unsupported value");
}
function prefix(left: string[], right: string[]) {
  return left.length <= right.length && left.every((key, index) => key === right[index]);
}
function assignment(path: string[], value: unknown): string {
  return `${path.map((key) => JSON.stringify(key)).join(".")} = ${literal(value)}\n`;
}
function replacement(
  part: Statement,
  section: string[],
  fields: string[][],
  value: Record<string, unknown>,
  handled: Set<string>,
): string | undefined {
  const path = part.path;
  if (!path) {
    return undefined;
  }
  const owns = fields.some((field) => prefix(field, path));
  const container = !part.table && fields.some((field) => prefix(path, field));
  if (container && !owns) {
    for (const field of fields.filter((field) => prefix(path, field))) {
      handled.add(JSON.stringify(field));
    }
    return assignment(path.slice(section.length), valueAt(value, path));
  }
  return owns ? "" : undefined;
}
function replacementsFor(
  parts: Statement[],
  fields: string[][],
  value: Record<string, unknown>,
  handled: Set<string>,
): Map<number, string> {
  const replacements = new Map<number, string>();
  let section: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.table && part.path) {
      section = part.path;
    }
    const content = replacement(part, section, fields, value, handled);
    if (content !== undefined) {
      replacements.set(index, content);
    }
  }
  return replacements;
}
function insertionPosition(
  parts: Statement[],
  field: string[],
  replacements: Map<number, string>,
): { at: number; parent: string[] } {
  let at = -1,
    parent: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (
      part.table &&
      part.path &&
      part.path.length < field.length &&
      prefix(part.path, field) &&
      part.path.length > parent.length &&
      !replacements.has(index)
    ) {
      at = index;
      parent = part.path;
    }
  }
  return { at, parent };
}
function insertionsFor(
  parts: Statement[],
  fields: string[][],
  value: Record<string, unknown>,
  handled: Set<string>,
  replacements: Map<number, string>,
): Map<number, string[]> {
  const insertions = new Map<number, string[]>();
  for (const field of fields) {
    if (handled.has(JSON.stringify(field)) || valueAt(value, field) === undefined) {
      continue;
    }
    const { at, parent } = insertionPosition(parts, field, replacements);
    const existing = insertions.get(at) ?? [];
    existing.push(assignment(field.slice(parent.length), valueAt(value, field)));
    insertions.set(at, existing);
  }
  return insertions;
}
/** Preserve unrelated statements, including tables and comments, while replacing changed leaves. */
export function editTomlConfig(text: string, value: Record<string, unknown>, fields: string[][]): string {
  const parts = statements(text),
    handled = new Set<string>();
  const replacements = replacementsFor(parts, fields, value, handled);
  const insertions = insertionsFor(parts, fields, value, handled, replacements);
  const content =
    (insertions.get(-1) ?? []).join("") +
    parts
      .map((part, index) => {
        const current = replacements.get(index) ?? part.text,
          added = (insertions.get(index) ?? []).join("");
        return current + (added && current && !current.endsWith("\n") ? "\n" : "") + added;
      })
      .join("");
  try {
    parse(content);
  } catch {
    throw new LintError(
      "unsupported-config",
      "Native TOML fields cannot be safely reconciled; expand overlapping inline tables first",
    );
  }
  return content;
}
