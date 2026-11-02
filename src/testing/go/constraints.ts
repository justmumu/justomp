import { TestError } from "../model";
export interface IntegrationConstraint {
  file: string;
  expression?: unknown;
  error?: string;
}
/** A bounded structural proof over the native Go parser's AST; no custom parser/SAT solver. */
function requiresIntegration(expression: unknown, negated = false): boolean {
  if (!expression || typeof expression !== "object") {
    return false;
  }
  const node = expression as Record<string, unknown>;
  if (typeof node.tag === "string") {
    return node.tag === "integration" && !negated;
  }
  if ("not" in node) {
    return requiresIntegration(node.not, !negated);
  }
  const children = node.and ?? node.or;
  if (!Array.isArray(children) || children.length !== 2) {
    return false;
  }
  const conjunction = "and" in node !== negated;
  return conjunction
    ? children.some((child) => requiresIntegration(child, negated))
    : children.every((child) => requiresIntegration(child, negated));
}
export function validateIntegrationConstraints(entries: readonly IntegrationConstraint[]): void {
  for (const entry of entries) {
    if (entry.error || !entry.expression) {
      throw new TestError(
        "invalid-integration-constraint",
        `${entry.file}: ${entry.error ?? "requires a leading //go:build integration constraint"}`,
      );
    }
    if (!requiresIntegration(entry.expression)) {
      throw new TestError(
        "unsupported-integration-constraint",
        `${entry.file}: constraint must require positive integration; use integration && (...), without an alternative that bypasses it`,
      );
    }
  }
}
