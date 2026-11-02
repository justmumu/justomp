import lint from "@commitlint/lint";
import conventionalCommits from "conventional-changelog-conventionalcommits";
import { type CommitPolicy } from "../config/commit/model";

export function commitRules(policy: CommitPolicy): NonNullable<Parameters<typeof lint>[1]> {
  return {
    "header-max-length": [2, "always", policy.header_max_length],
    "type-enum": [2, "always", policy.types],
    "type-empty": [2, "never"],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
  };
}
export async function validateMessage(message: string, policy: CommitPolicy) {
  if (typeof message !== "string" || !message.trim() || message.includes("\0")) {
    return {
      valid: false,
      errors: [
        {
          name: "message",
          message: "A nonempty commit message without NUL bytes is required",
        },
      ],
      warnings: [],
    };
  }
  // The preset's published declaration returns {}; the installed runtime exposes parser.
  const preset = conventionalCommits() as {
    parser: NonNullable<Parameters<typeof lint>[2]>["parserOpts"];
  };
  const result = await lint(message, commitRules(policy), {
    ...(preset.parser === undefined ? {} : { parserOpts: preset.parser }),
    defaultIgnores: false,
    ignores: [(value) => policy.ignore_prefixes.some((prefix) => value.startsWith(prefix))],
  });
  return {
    valid: result.valid,
    errors: result.errors.map((e) => ({ name: e.name, message: e.message })),
    warnings: result.warnings.map((e) => ({
      name: e.name,
      message: e.message,
    })),
  };
}
