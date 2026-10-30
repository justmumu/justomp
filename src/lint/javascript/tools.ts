import type { JavascriptPolicy } from "../../config/lint/model";
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
    "prettier",
    ...javascriptPlugins(policy, target, await collectLintScope(target)),
  ];
}
