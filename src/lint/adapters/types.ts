import { type LintPolicy } from "../../config/lint/model";
import { type ProcessResult } from "../../dependencies/model";
import { type LintCheck, type LintEcosystem, type PreparationChange } from "../model";
import { type ProjectionPlan } from "../projection";
import { type LintTarget } from "../targets";

export type ToolVersions = Record<string, string>;
export interface LintOperationContext {
  /** All members of one ecosystem sharing a manager owner; one lease is already held. */
  targets: LintTarget[];
  versions: Record<string, ToolVersions>;
  policy: LintPolicy;
  signal: AbortSignal;
  /** Append actual effects even when a subsequent native step fails. */
  changes: PreparationChange[];
}
export interface LintCheckContext {
  target: LintTarget;
  versions: ToolVersions;
  policy: LintPolicy;
  projection: ProjectionPlan;
  signal: AbortSignal;
}
export interface LintAdapter {
  /** Fresh discovery resolves latest once per shared tool. JS also reconciles required plugins.
   * Existing pins mean repair: resolve newly needed tools and align their consumers, retaining unrelated targets. */
  resolve(
    targets: LintTarget[],
    policy: LintPolicy,
    signal: AbortSignal,
    existing?: Record<string, ToolVersions>,
  ): Promise<Record<string, ToolVersions>>;
  /** Read-only compatibility checks; called before projection or native mutations. */
  preflight(context: LintOperationContext): Promise<void>;
  /** Uses the existing native manager, never reacquires dependency domains. */
  prepareBatch(context: LintOperationContext): Promise<void>;
  /** Verify actual declarations, lock and executable; receipts are only hints. */
  verify(context: LintCheckContext): Promise<boolean>;
  check(context: LintCheckContext): Promise<LintCheck[]>;
  /** Native source mutation, called only with explicit owned files under the ready lease. */
  fix?(context: LintCheckContext, files: readonly string[]): Promise<ProcessResult>;
}
export type LintAdapterRegistry = Readonly<Partial<Record<LintEcosystem, LintAdapter>>>;
