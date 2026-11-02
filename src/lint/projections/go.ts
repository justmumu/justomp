import { stringify } from "yaml";
import { type GoPolicy } from "../../config/lint/model";
import { object } from "../../dependencies/inventory";
import { LintError } from "../model";

function validateContainers(config: GoPolicy["golangci"]): void {
  for (const key of ["run", "issues"]) {
    const value = config[key];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new LintError("unsupported-config", `Go lint ${key} must be an object`);
    }
  }
}
/** Output destinations and mutation/runner flags belong to the check executor, not policy. */
export function projectGo(policy: GoPolicy): string {
  const config = policy.golangci;
  if (config.output !== undefined) {
    throw new LintError(
      "unsupported-config",
      "Go lint output is owned by justomp; remove golangci.output from the shared policy",
    );
  }
  validateContainers(config);
  const run = object(config.run),
    issues = object(config.issues);
  for (const [key, expected] of Object.entries({
    "allow-parallel-runners": false,
    "allow-serial-runners": false,
    "modules-download-mode": "readonly",
    "issues-exit-code": 1,
    "relative-path-mode": "cfg",
  })) {
    if (key in run && run[key] !== expected) {
      throw new LintError("unsupported-config", `Go lint run.${key} must be ${JSON.stringify(expected)}`);
    }
  }
  for (const [key, expected] of Object.entries({
    fix: false,
    new: false,
    "new-from-rev": "",
    "new-from-merge-base": "",
    "new-from-patch": "",
    "max-issues-per-linter": 0,
    "max-same-issues": 0,
    "uniq-by-line": false,
  })) {
    if (key in issues && issues[key] !== expected) {
      throw new LintError(
        "unsupported-config",
        `Go lint issues.${key} must be ${JSON.stringify(expected)} for complete check-only results`,
      );
    }
  }
  return stringify({
    ...config,
    version: "2",
    run: {
      ...run,
      "modules-download-mode": "readonly",
      "allow-parallel-runners": false,
      "allow-serial-runners": false,
      "issues-exit-code": 1,
      "relative-path-mode": "cfg",
    },
    issues: {
      ...issues,
      fix: false,
      "max-issues-per-linter": 0,
      "max-same-issues": 0,
      "uniq-by-line": false,
    },
    output: {
      formats: { json: { path: "stdout" } },
      "show-stats": false,
      "path-mode": "abs",
    },
  });
}
