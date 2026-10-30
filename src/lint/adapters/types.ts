import type { LintPolicy } from "../../config/lint/model";
import type { LintCheck, LintEcosystem, PreparationChange } from "../model";
import type { ProjectionPlan } from "../projection";
import type { LintTarget } from "../targets";

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
  /** Python resolves once per discovery wave. JS also reconciles required plugins.
   * With existing pins, never query latest for a retained tool; resolve missing tools only. */
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
}
export type LintAdapterRegistry = Readonly<
  Partial<Record<LintEcosystem, LintAdapter>>
>;
