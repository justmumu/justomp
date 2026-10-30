import { parse } from "smol-toml";
import type { PythonPolicy } from "../../config/lint/model";
import { LintError } from "../model";

const PROJECT_FIELDS = new Set(["src", "target-version"]);

interface Statement {
  text: string;
  path?: string[];
  table?: boolean;
}
function keyPath(key: string): string[] {
  let node: unknown = parse(`${key} = 0`);
  const path: string[] = [];
  while (node && typeof node === "object") {
    const entry = Object.entries(node)[0];
    if (!entry) break;
    path.push(entry[0]);
    node = entry[1];
  }
  return path;
}
function assignmentKey(text: string): string {
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "=") return text.slice(0, index).trim();
  }
  throw new LintError("invalid-config", "Invalid TOML assignment");
}
/** Parse complete statements, so header-like text in multiline strings is inert. */
function statements(text: string): Statement[] {
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
    while (true) {
      try {
        parse(value);
        break;
      } catch (error) {
        if (++index >= lines.length) throw error;
        value += lines[index];
      }
    }
    if (table) {
      // Find the closing bracket outside quoted keys; comments may contain brackets.
      const start =
        value.indexOf("[") + (value.trimStart().startsWith("[[") ? 2 : 1);
      let quote = "",
        end = start;
      for (; end < value.length; end++) {
        const char = value[end];
        if (quote) {
          if (char === "\\" && quote === '"') end++;
          else if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "]") break;
      }
      section = keyPath(value.slice(start, end));
      result.push({ text: value, path: section, table: true });
    } else
      result.push({
        text: value,
        path: [...section, ...keyPath(assignmentKey(value))],
      });
  }
  return result;
}
function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`)
      .join(", ")} }`;
  throw new LintError(
    "invalid-config",
    "Ruff policy contains a value TOML cannot represent",
  );
}
/** Replace policy-owned Ruff fields only; every other statement retains its bytes. */
export function projectPython(before: string, policy: PythonPolicy): string {
  const parsed = parse(before);
  const parts = statements(before);
  const owned = new Set(Object.keys(policy.ruff));
  const isRuff = (path: string[]) => path[0] === "tool" && path[1] === "ruff";
  const rootTable = parts.find(
    (part) => part.table && part.path?.length === 2 && isRuff(part.path),
  );
  // Inline/dotted ancestor containers cannot be split without rewriting unrelated values.
  for (const part of parts) {
    if (!part.path || part.table) continue;
    if (
      part.path[0] === "tool" &&
      part.path.length < 3 &&
      (parsed.tool as Record<string, unknown> | undefined)?.ruff !== undefined
    )
      throw new LintError(
        "unsupported-config",
        "Inline tool/ruff tables require expanded [tool.ruff] configuration before projection",
      );
    if (!rootTable && isRuff(part.path) && !owned.has(part.path[2] ?? ""))
      throw new LintError(
        "unsupported-config",
        "Dotted Ruff configuration requires an explicit [tool.ruff] table before projection",
      );
  }
  const local = (parsed.tool as { ruff?: Record<string, unknown> } | undefined)
    ?.ruff;
  for (const field of Object.keys(local ?? {}))
    if (!owned.has(field) && !PROJECT_FIELDS.has(field))
      throw new LintError(
        "config-conflict",
        `Project-local Ruff option "${field}" is absent from the shared policy; move it to lint.python.ruff in the root .justomp/config.json or remove it from this pyproject.toml`,
      );
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const replacement = Object.entries(policy.ruff)
    .map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}${eol}`)
    .join("");
  let output = "";
  for (const part of parts) {
    if (part === rootTable) {
      output += part.text + (part.text.endsWith("\n") ? "" : eol) + replacement;
      continue;
    }
    if (part.path && isRuff(part.path) && owned.has(part.path[2] ?? ""))
      continue;
    output += part.text;
  }
  if (!rootTable)
    output += `${output && !output.endsWith("\n") ? eol : ""}[tool.ruff]${eol}${replacement}`;
  // Native syntax validation is also a postcondition for unusual quoted/dotted keys.
  parse(output);
  return output;
}
