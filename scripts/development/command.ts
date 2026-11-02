import { type TestRequest } from "../../src/testing/model";
import { parseTestRequest } from "../../src/testing/request";
import { assertNonemptyTests, type DevelopmentReceipt, ROOT_PROJECT_ID, record, unitResult, WORKLOAD } from "./receipt";
import { invokeDevelopment, repositoryScope } from "./services";

const actions = ["setup", "check", "lint", "lint-fix", "format", "typecheck", "test", "integration"] as const;
export type DevelopmentAction = (typeof actions)[number];
export interface DevelopmentCommand {
  action: DevelopmentAction;
  request: TestRequest;
  report?: string;
  group?: "dependencies" | "lint" | "typecheck";
}
function actionName(value: string | undefined): DevelopmentAction {
  const action = actions.find((candidate) => candidate === value);
  if (!action) {
    throw new Error(`Expected one of: ${actions.join(", ")}`);
  }
  return action;
}
function options(args: readonly string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !key ||
      !["--report", "--test-file", "--timeout-seconds", "--group"].includes(key) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error("Expected --report, --test-file, --timeout-seconds or --group followed by a value");
    }
    const previous = values.get(key) ?? [];
    if (previous.length && key !== "--test-file") {
      throw new Error(`Duplicate ${key}`);
    }
    values.set(key, [...previous, value]);
  }
  return values;
}
export function parseDevelopmentArgs(args: readonly string[]): DevelopmentCommand {
  const action = actionName(args[0]),
    values = options(args.slice(1));
  const files = values.get("--test-file"),
    timeout = values.get("--timeout-seconds")?.[0];
  const group = values.get("--group")?.[0],
    report = values.get("--report")?.[0];
  validateSelection(action, files, timeout, group);
  return {
    action,
    request: parseTestRequest({
      project_id: ROOT_PROJECT_ID,
      ...(files ? { test_files: files } : {}),
      ...(timeout ? { timeout_seconds: Number(timeout) } : {}),
    }),
    ...(report ? { report } : {}),
    ...(group ? { group: group as NonNullable<DevelopmentCommand["group"]> } : {}),
  };
}
function validateSelection(
  action: DevelopmentAction,
  files: string[] | undefined,
  timeout: string | undefined,
  group: string | undefined,
): void {
  if ((files || timeout) && action !== "test" && action !== "integration") {
    throw new Error("Test selection is only supported for test and integration");
  }
  if (group && (action !== "integration" || files || !["dependencies", "lint", "typecheck"].includes(group))) {
    throw new Error("Integration --group accepts dependencies, lint or typecheck without --test-file");
  }
}
function groupFiles(files: string[], group: NonNullable<DevelopmentCommand["group"]>): string[] {
  const selected = files.filter(
    (file) =>
      file.startsWith(`tests/integration/${group}/`) ||
      (group === "dependencies"
        ? file.startsWith("tests/integration/omp/")
        : [`tests/integration/omp/${group}.test.ts`, `tests/integration/omp/${group}.native.test.ts`].includes(file)),
  );
  if (!selected.length) {
    throw new Error(`No managed integration tests for ${group}`);
  }
  return selected;
}
export async function runDevelopment(
  root: string,
  command: DevelopmentCommand,
  signal = new AbortController().signal,
): Promise<DevelopmentReceipt> {
  const receipt: DevelopmentReceipt = {
    version: 1,
    workload: WORKLOAD,
    root,
    project_id: ROOT_PROJECT_ID,
    action: command.action,
    source_count: 0,
    success: false,
    complete: false,
    cancelled: false,
    result: null,
    errors: [],
  };
  try {
    signal.throwIfAborted();
    const scope = await repositoryScope(root, command.action === "integration" ? "integration" : "unit", signal);
    receipt.source_count = scope.sources.length;
    if (!receipt.source_count) {
      throw new Error("Repository owned source scope is empty");
    }
    const selected = command.group
      ? { ...command, request: { ...command.request, test_files: groupFiles(scope.tests, command.group) } }
      : command;
    receipt.result = await invokeDevelopment(root, selected, signal);
    const result = record(receipt.result);
    receipt.complete = result.complete === true;
    signal.throwIfAborted();
    if (result.success === true && receipt.complete) {
      validateTestEvidence(command.action, receipt.result);
      receipt.success = true;
    }
  } catch (error) {
    receipt.errors.push(error instanceof Error ? error.message : String(error));
  }
  receipt.cancelled = signal.aborted;
  if (receipt.cancelled) {
    receipt.complete = false;
  }
  return receipt;
}
function validateTestEvidence(action: DevelopmentAction, result: unknown): void {
  if (action === "check") {
    assertNonemptyTests(unitResult(result));
  }
  if (action === "test" || action === "integration") {
    assertNonemptyTests(result);
  }
}
