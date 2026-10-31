import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FormatPolicy } from "../config/format/model";
import type { LintPolicy } from "../config/lint/model";
import type { LintTarget } from "../lint/targets";
import { collectOwnedFiles } from "../packaging/file-scope";
import { assertGoFormatPolicy, isGeneratedGo } from "./go-policy";
import type { FormatScope } from "./model";
import { filterPythonFormatScope } from "./python-scope";
import {
  createFormatScope,
  formatExclusionMatcher,
  formatFileMatcher,
  isFormatDependencyPath,
} from "./selection";

export async function collectFormatScope(
  target: LintTarget,
  policy: FormatPolicy,
  lint: LintPolicy,
  requestedFiles?: readonly string[],
): Promise<FormatScope> {
  const excluded = formatExclusionMatcher(policy);
  const eligible = formatFileMatcher(target.project.ecosystem, policy);
  const metadata = await collectOwnedFiles(target, {
    boundaryRoot: target.scope.cwd,
    excludeDirectory: (path, name) =>
      name === ".git" || isFormatDependencyPath(path) || excluded(path),
    includeFile: async (path) => {
      if (!eligible(path)) return false;
      return (
        target.project.ecosystem !== "go" ||
        !path.endsWith(".go") ||
        !isGeneratedGo(await readFile(resolve(target.scope.cwd, path), "utf8"))
      );
    },
  });
  const scope = filterPythonFormatScope(
    createFormatScope(
      { ...metadata, ecosystem: target.project.ecosystem },
      policy,
    ),
    target.scope.cwd,
    lint.python,
    requestedFiles,
  );
  if (
    scope.ecosystem === "go" &&
    scope.files.some((path) => path.endsWith(".go"))
  )
    assertGoFormatPolicy(lint.go);
  return scope;
}
