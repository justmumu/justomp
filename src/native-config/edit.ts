import { applyEdits, parse as jsonc, modify, type ParseError } from "jsonc-parser";
import { parse as toml } from "smol-toml";
import { parseDocument } from "yaml";
import { object } from "../dependencies/inventory";
import { LintError } from "../lint/model";
import { reconcileFields } from "./ownership";
import { editScriptConfig } from "./script";
import { editTomlConfig } from "./toml";
import { valueAt } from "./values";

export interface NativeEdit {
  content: string;
  fields: string[][];
}
export function configObject(text: string, path: string): Record<string, unknown> {
  let data: unknown;
  if (path.endsWith(".toml")) {
    data = toml(text);
  } else if (/\.ya?ml$/.test(path) || path.endsWith("/.prettierrc")) {
    const doc = parseDocument(text);
    if (doc.errors.length) {
      throw new LintError("unsupported-config", `Invalid native configuration: ${path}`);
    }
    data = doc.toJS();
  } else {
    const errors: ParseError[] = [];
    data = jsonc(text, errors, { allowTrailingComma: true });
    if (errors.length) {
      throw new LintError("unsupported-config", `Invalid native configuration: ${path}`);
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LintError("unsupported-config", `Native configuration must be an object: ${path}`);
  }
  return object(data);
}
function wrap(value: Record<string, unknown>, prefix: string[]): Record<string, unknown> {
  for (const part of [...prefix].reverse()) {
    value = { [part]: value };
  }
  return value;
}

function changedFields(value: Record<string, unknown>, previous: readonly string[][], fields: string[][]): string[][] {
  const changes = [...previous, ...fields].filter(
    (field, index, all) => all.findIndex((item) => JSON.stringify(item) === JSON.stringify(field)) === index,
  );
  for (const field of previous) {
    for (let length = field.length - 1; length > 0; length--) {
      const parent = field.slice(0, length);
      if (
        valueAt(value, parent) === undefined &&
        !changes.some((item) => JSON.stringify(item) === JSON.stringify(parent))
      ) {
        changes.push(parent);
      }
    }
  }
  return changes;
}
function editYaml(text: string | null, value: Record<string, unknown>, changes: string[][]): string {
  const doc = parseDocument(text ?? "{}");
  for (const field of changes) {
    const item = valueAt(value, field);
    if (item === undefined) {
      doc.deleteIn(field);
    } else {
      doc.setIn(field, item);
    }
  }
  return doc.toString();
}
function editJson(text: string | null, value: Record<string, unknown>, changes: string[][]): string {
  let content = text ?? "{}\n";
  for (const field of changes) {
    content = applyEdits(
      content,
      modify(content, field, valueAt(value, field), { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  }
  return content;
}
/** Apply policy leaves without evaluating project code or replacing unrelated native settings. */
export function editNativeConfig(
  text: string | null,
  path: string,
  desired: Record<string, unknown>,
  previous: readonly string[][] = [],
  prefix: string[] = [],
): NativeEdit {
  const policy = wrap(desired, prefix);
  if (/\.[cm]?[jt]s$/.test(path) || path.endsWith(".json5")) {
    return editScriptConfig(text, path, policy, previous);
  }
  const before = text === null ? {} : configObject(text, path);
  const { value, fields } = reconcileFields(before, policy, previous);
  const changes = changedFields(value, previous, fields);
  if (path.endsWith(".toml")) {
    return { content: editTomlConfig(text ?? "", value, changes), fields };
  }
  if (/\.ya?ml$/.test(path) || path.endsWith("/.prettierrc")) {
    return { content: editYaml(text, value, changes), fields };
  }
  return { content: editJson(text, value, changes), fields };
}
