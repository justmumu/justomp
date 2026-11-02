import { type ProcessResult } from "../../../src/dependencies/model";

export function measuredVersion(manager: string, expected: string, result: ProcessResult): string {
  const version = result.stdout.trim();
  if (result.exit_code !== 0 || result.truncated || result.cancelled || version !== expected) {
    throw new Error(`Native ${manager} test requires ${expected}; measured ${version}. ${result.stderr}`);
  }
  return version;
}
