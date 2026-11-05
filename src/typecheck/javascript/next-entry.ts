import { join, resolve } from "node:path";
import { parse } from "@babel/parser";
import { object } from "../../dependencies/inventory";
import { readProjectionFile } from "../../lint/files";
import { TypecheckError } from "../model";
import { type TypecheckTarget } from "../targets";

function unsupported(path: string): never {
  throw new TypecheckError(
    "unsupported-config",
    `Cannot statically select Next TypeScript configuration from ${path}; use an exported object with a literal typescript.tsconfigPath`,
  );
}
function unwrap(value: unknown): Record<string, unknown> {
  let node = object(value);
  while (["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"].includes(String(node.type))) {
    node = object(node.expression);
  }
  return node;
}
function exportedValue(statement: unknown): Record<string, unknown> | undefined {
  const item = object(statement);
  if (item.type === "ExportDefaultDeclaration") {
    return unwrap(item.declaration);
  }
  const expression = object(item.expression),
    left = object(expression.left);
  if (
    item.type === "ExpressionStatement" &&
    expression.type === "AssignmentExpression" &&
    expression.operator === "=" &&
    left.type === "MemberExpression" &&
    left.computed === false &&
    object(left.object).name === "module" &&
    object(left.property).name === "exports"
  ) {
    return unwrap(expression.right);
  }
  return undefined;
}
function property(node: Record<string, unknown>, name: string, path: string): Record<string, unknown> | undefined {
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    unsupported(path);
  }
  let found: Record<string, unknown> | undefined;
  for (const raw of node.properties) {
    const item = object(raw);
    if (propertyName(item, path) !== name) {
      continue;
    }
    if (found || item.type !== "ObjectProperty") {
      unsupported(path);
    }
    found = unwrap(item.value);
  }
  return found;
}
/** Parse the selected field without importing project code or evaluating unrelated callbacks. */
export function staticNextTypescriptPath(text: string, path: string): string {
  const program = parse(text, { sourceType: "unambiguous", plugins: ["typescript"] }).program;
  const roots = program.body.map(exportedValue).filter((value) => value !== undefined);
  if (roots.length !== 1 || !roots[0]) {
    unsupported(path);
  }
  const typescript = property(roots[0], "typescript", path);
  const selected = typescript ? property(typescript, "tsconfigPath", path) : undefined;
  if (!selected) {
    return "tsconfig.json";
  }
  if (selected.type !== "StringLiteral" || typeof selected.value !== "string" || !selected.value) {
    unsupported(path);
  }
  return selected.value;
}
export async function nextTypescriptEntry(target: TypecheckTarget): Promise<string | undefined> {
  const candidates = [];
  for (const name of ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]) {
    const path = join(target.scope.cwd, name),
      snapshot = await readProjectionFile(target.root, path);
    if (snapshot.text !== null) {
      candidates.push({ path, text: snapshot.text });
    }
  }
  if (candidates.length > 1) {
    unsupported(candidates.map((candidate) => candidate.path).join(", "));
  }
  const config = candidates[0];
  return config ? resolve(target.scope.cwd, staticNextTypescriptPath(config.text, config.path)) : undefined;
}

function propertyName(item: Record<string, unknown>, path: string): unknown {
  if (item.type === "SpreadElement" || item.computed) {
    unsupported(path);
  }
  const key = object(item.key);
  return key.type === "Identifier" ? key.name : key.value;
}
