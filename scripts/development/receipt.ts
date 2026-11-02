export const ROOT_PROJECT_ID = "javascript:package.json";
export const WORKLOAD = "justomp-managed-checks-v1";
export interface DevelopmentReceipt {
  version: 1;
  workload: typeof WORKLOAD;
  root: string;
  project_id: typeof ROOT_PROJECT_ID;
  action: string;
  source_count: number;
  success: boolean;
  complete: boolean;
  cancelled: boolean;
  result: unknown;
  errors: string[];
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a structured command result");
  }
  return value as Record<string, unknown>;
}
export function unitResult(value: unknown): unknown {
  const gate = record(value);
  if (!Array.isArray(gate.stages)) {
    throw new Error("Check did not return stages");
  }
  const stage = gate.stages.map(record).find((item) => item.stage === "unit" && item.project_id === ROOT_PROJECT_ID);
  if (!stage) {
    throw new Error("Check did not return the root unit result");
  }
  if (stage.success !== true || stage.complete !== true) {
    throw new Error("Root unit stage did not pass completely");
  }
  return stage.details;
}
export function assertNonemptyTests(value: unknown): void {
  const tests = record(record(value).tests);
  if (typeof tests.total !== "number" || !Number.isSafeInteger(tests.total) || tests.total <= 0) {
    throw new Error("Repository tests require a nonempty completed result");
  }
}
