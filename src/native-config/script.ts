import { parse, parseExpression } from "@babel/parser";
import { object } from "../dependencies/inventory";
import { LintError } from "../lint/model";
import { type NativeEdit } from "./edit";
import { reconcileFields } from "./ownership";
import { valueAt } from "./values";

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
function node(value: unknown): Node {
  const item = object(value);
  if (typeof item.type !== "string" || typeof item.start !== "number" || typeof item.end !== "number") {
    throw new Error("Invalid config syntax node");
  }
  return item as Node;
}
function unsupported(path: string): never {
  throw new LintError(
    "unsupported-config",
    `Cannot statically edit native config ${path}; use an exported object or imported defineConfig(object) without dynamic policy fields`,
  );
}
function unwrap(value: Node): Node {
  while (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(value.type)) {
    value = node(value.expression);
  }
  return value;
}
function defineConfigNames(body: Node[]): Set<string> {
  const names = new Set<string>();
  for (const item of body) {
    if (
      item.type !== "ImportDeclaration" ||
      !["vitest/config", "vite", "prettier"].includes(String(object(item.source).value))
    ) {
      continue;
    }
    for (const raw of item.specifiers as unknown[]) {
      const spec = node(raw);
      if (spec.type === "ImportSpecifier" && object(spec.imported).name === "defineConfig") {
        names.add(String(object(spec.local).name));
      }
    }
  }
  return names;
}
function commonJsValue(item: Node): Node | undefined {
  if (item.type !== "ExpressionStatement") {
    return undefined;
  }
  const expression = node(item.expression);
  if (expression.type !== "AssignmentExpression" || expression.operator !== "=") {
    return undefined;
  }
  const left = node(expression.left);
  if (
    left.type === "MemberExpression" &&
    left.computed === false &&
    object(left.object).name === "module" &&
    object(left.property).name === "exports"
  ) {
    return unwrap(node(expression.right));
  }
  return undefined;
}
function exportedObject(item: Node, definitions: Set<string>, path: string): Node | undefined {
  let value = item.type === "ExportDefaultDeclaration" ? unwrap(node(item.declaration)) : commonJsValue(item);
  if (!value) {
    return undefined;
  }
  if (
    value.type === "CallExpression" &&
    definitions.has(String(object(value.callee).name)) &&
    Array.isArray(value.arguments) &&
    value.arguments.length === 1
  ) {
    value = unwrap(node(value.arguments[0]));
  }
  if (value.type !== "ObjectExpression") {
    unsupported(path);
  }
  return value;
}
function moduleExportReference(value: Record<string, unknown>): boolean {
  if (value.type !== "MemberExpression" || object(value.object).name !== "module") {
    return false;
  }
  const property = object(value.property);
  if (value.computed === false) {
    return property.name === "exports";
  }
  return property.type !== "StringLiteral" || property.value === "exports";
}
function referencesExport(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(referencesExport);
  }
  const item = object(value);
  if (item.type === "Identifier" && item.name === "exports") {
    return true;
  }
  if (moduleExportReference(item)) {
    return true;
  }
  return Object.entries(item).some(([key, child]) => {
    if (item.computed !== true && ["key", "property"].includes(key)) {
      return false;
    }
    return typeof child === "object" && child !== null && referencesExport(child);
  });
}
function assertStableExport(body: Node[], root: Node, path: string): void {
  for (const item of body) {
    const ownsExport = item.start <= root.start && item.end >= root.end;
    if (!ownsExport && item.type !== "ImportDeclaration" && referencesExport(item)) {
      throw new LintError(
        "unsupported-config",
        `Cannot statically edit native config ${path}; another statement accesses the exported configuration and may override managed fields`,
      );
    }
  }
}
function configRoot(text: string, path: string): Node {
  if (path.endsWith(".json5")) {
    const value = node(parseExpression(text));
    if (value.type !== "ObjectExpression") {
      unsupported(path);
    }
    return value;
  }
  const body = parse(text, { sourceType: "unambiguous", plugins: ["typescript"] }).program.body.map(node);
  const definitions = defineConfigNames(body);
  const roots = body
    .map((item) => exportedObject(item, definitions, path))
    .filter((item): item is Node => item !== undefined);
  if (roots.length !== 1 || !roots[0]) {
    unsupported(path);
  }
  assertStableExport(body, roots[0], path);
  return roots[0];
}
interface Property {
  name: string;
  property: Node;
  value: Node;
}
function propertyName(property: Node, path: string): string {
  if (property.type === "SpreadElement" || property.computed) {
    unsupported(path);
  }
  const key = node(property.key);
  if (key.type === "Identifier") {
    return String(key.name);
  }
  if (key.type === "StringLiteral") {
    return String(key.value);
  }
  return unsupported(path);
}
function properties(value: Node, path: string): Property[] {
  const result: Property[] = [];
  for (const raw of value.properties as unknown[]) {
    const property = node(raw),
      name = propertyName(property, path);
    if (result.some((item) => item.name === name)) {
      unsupported(path);
    }
    result.push({
      name,
      property,
      value: property.type === "ObjectProperty" ? unwrap(node(property.value)) : property,
    });
  }
  return result;
}
function nested(path: string[], value: unknown): unknown {
  for (const key of [...path].reverse()) {
    value = { [key]: value };
  }
  return value;
}
function insertProperty(text: string, parent: Node, props: Property[], field: string[], value: unknown): string {
  if (value === undefined) {
    return text;
  }
  const [head, ...tail] = field,
    end = parent.end - 1,
    last = props.at(-1)?.property;
  const gap = last ? text.slice(last.end, end).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "") : "";
  const separator = last && !gap.includes(",") ? "," : "";
  return (
    text.slice(0, end) +
    `${separator}\n${JSON.stringify(head)}: ${JSON.stringify(nested(tail, value))}\n` +
    text.slice(end)
  );
}
function removeProperty(text: string, parent: Node, props: Property[], item: Property): string {
  const index = props.indexOf(item),
    next = props[index + 1]?.property,
    previous = props[index - 1]?.property;
  let start = item.property.start,
    end = item.property.end;
  if (next) {
    end = next.start;
  } else if (previous) {
    const comma = text.indexOf(",", previous.end);
    if (comma >= 0 && comma < start) {
      start = comma;
    }
  } else {
    const comma = text.indexOf(",", end);
    if (comma >= 0 && comma < parent.end) {
      end = comma + 1;
    }
  }
  return text.slice(0, start) + text.slice(end);
}
function update(text: string, parent: Node, field: string[], value: unknown, path: string): string {
  const [head, ...tail] = field;
  if (!head) {
    return text;
  }
  const props = properties(parent, path),
    item = props.find((prop) => prop.name === head);
  if (!item) {
    return insertProperty(text, parent, props, field, value);
  }
  if (item.property.type !== "ObjectProperty") {
    unsupported(path);
  }
  if (tail.length) {
    if (item.value.type !== "ObjectExpression") {
      unsupported(path);
    }
    return update(text, item.value, tail, value, path);
  }
  if (value !== undefined) {
    return text.slice(0, item.value.start) + JSON.stringify(value) + text.slice(item.value.end);
  }
  return removeProperty(text, parent, props, item);
}

export function editScriptConfig(
  text: string | null,
  path: string,
  desired: Record<string, unknown>,
  previous: readonly string[][],
): NativeEdit {
  const { value, fields } = reconcileFields({}, desired);
  let content =
    text ??
    (path.endsWith(".json5") ? "{}\n" : /\.c[jt]s$/.test(path) ? "module.exports = {};\n" : "export default {};\n");
  const edits = [...previous, ...fields].filter(
    (field, index, all) => all.findIndex((item) => JSON.stringify(item) === JSON.stringify(field)) === index,
  );
  for (const field of edits) {
    content = update(content, configRoot(content, path), field, valueAt(value, field), path);
  }
  configRoot(content, path);
  return { content, fields };
}
