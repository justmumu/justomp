import { TestError, type TestRequest } from "./model";
export function parseTestRequest(input: unknown): TestRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalidRequest("Expected a project_test request");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((k) => !["project_id", "test_files", "timeout_seconds"].includes(k))) {
    invalidRequest("Unexpected project_test field");
  }
  if (typeof value.project_id !== "string" || !value.project_id.trim()) {
    invalidRequest("project_id is required");
  }
  const timeout = Object.hasOwn(value, "timeout_seconds") ? value.timeout_seconds : 300;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0) {
    invalidRequest("timeout_seconds must be a positive integer");
  }
  const files = requestedFiles(value);
  return {
    project_id: value.project_id as string,
    timeout_seconds: timeout as number,
    ...(files ? { test_files: [...new Set(files)] } : {}),
  };
}

function invalidRequest(message: string): never {
  throw new TestError("invalid-input", message);
}
function requestedFiles(value: Record<string, unknown>): string[] | undefined {
  let files: string[] | undefined;
  if (Object.hasOwn(value, "test_files")) {
    if (!Array.isArray(value.test_files) || !value.test_files.length) {
      invalidRequest("test_files must be a nonempty array");
    }
    files = [];
    for (const file of value.test_files as unknown[]) {
      validateFile(file);
      files.push(file as string);
    }
  }
  return files;
}

function validateFile(file: unknown): void {
  if (
    typeof file !== "string" ||
    !file ||
    file.startsWith("/") ||
    /^[a-zA-Z]:/.test(file) ||
    file.includes("\\") ||
    file.includes("::") ||
    file.includes("\0") ||
    file.split("/").some((p) => !p || p === "." || p === "..")
  ) {
    invalidRequest("test_files must contain exact project-relative file paths");
  }
}
