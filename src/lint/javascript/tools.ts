import type { JavascriptPolicy } from "../../config/lint/model";
import type { ToolVersions } from "../adapters/types";
import { javascriptPlugins } from "../projections/javascript";
import { collectLintScope } from "../scope";
import type { LintTarget } from "../targets";

export async function requiredJavascriptTools(
  target: LintTarget,
  policy: JavascriptPolicy,
): Promise<string[]> {
  return [
    "eslint",
    "@eslint/js",
    ...javascriptPlugins(policy, target, await collectLintScope(target)),
  ];
}

/** Legacy receipts may retain target Prettier; bundled formatting no longer manages it. */
export function nativeJavascriptTools(tools: ToolVersions): ToolVersions {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => name !== "prettier"),
  );
}
