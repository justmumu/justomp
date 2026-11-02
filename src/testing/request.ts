import { TestError, type TestRequest } from "./model";
export function parseTestRequest(input: unknown): TestRequest {
  const fail = (message: string): never => {
    throw new TestError("invalid-input", message);
  };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail("Expected a project_test request");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((k) => !["project_id", "test_files", "timeout_seconds"].includes(k))) {
    fail("Unexpected project_test field");
  }
  if (typeof value.project_id !== "string" || !value.project_id.trim()) {
    fail("project_id is required");
  }
  const timeout = Object.hasOwn(value, "timeout_seconds") ? value.timeout_seconds : 300;
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout <= 0) {
    fail("timeout_seconds must be a positive integer");
  }
  let files: string[] | undefined;
  if (Object.hasOwn(value, "test_files")) {
    if (!Array.isArray(value.test_files) || !value.test_files.length) {
      fail("test_files must be a nonempty array");
    }
    files = [];
    for (const file of value.test_files as unknown[]) {
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
        fail("test_files must contain exact project-relative file paths");
      }
      files.push(file as string);
    }
  }
  return {
    project_id: value.project_id as string,
    timeout_seconds: timeout as number,
    ...(files ? { test_files: [...new Set(files)] } : {}),
  };
}
