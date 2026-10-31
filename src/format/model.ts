import type { LintEcosystem } from "../lint/model";

export class FormatError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FormatError";
  }
}
export interface FormatScope {
  ecosystem: LintEcosystem;
  /** Eligible owned regular files, relative to the selected project. */
  files: string[];
}
export type Formatter =
  | { engine: "ruff" | "go" }
  | { engine: "prettier"; parser: string };
