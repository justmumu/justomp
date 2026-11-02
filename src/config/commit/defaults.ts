import { type CommitPolicy } from "./model";
export const COMMIT_DEFAULTS: CommitPolicy = {
  header_max_length: 72,
  types: ["feat", "fix", "docs", "chore", "ci", "refactor", "test", "style", "build", "perf", "revert"],
  ignore_prefixes: ["Merge ", "fixup! ", "squash! ", "amend! ", 'Revert "'],
};
