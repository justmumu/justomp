import type { InspectionRules } from "./model";

export function validatePattern(pattern: unknown): asserts pattern is string {
  if (
    typeof pattern !== "string" ||
    !pattern ||
    pattern.startsWith("/") ||
    /^[a-zA-Z]:/.test(pattern) ||
    pattern.split("/").some((p) => p === ".." || p === "." || p === "") ||
    /[!\\?[\]{}()]/.test(pattern) ||
    pattern.includes("***")
  )
    throw new Error(
      `Invalid inspection pattern: ${String(pattern)}; use relative paths with * or **`,
    );
}
export function validateRules(
  input: unknown,
): asserts input is InspectionRules {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("inspection_rules must be an object");
  for (const field of ["include", "exclude"] as const) {
    const values = (input as Record<string, unknown>)[field];
    if (!Array.isArray(values))
      throw new Error(`inspection_rules.${field} must be an array`);
    for (const value of values) validatePattern(value);
  }
}
