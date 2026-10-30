import type { TypecheckPolicy } from "../../config/typecheck/model";
import type {
  PreparationChange,
  TypecheckCheck,
  TypecheckEcosystem,
} from "../model";
import type { ProjectionPlan } from "../projection";
import type { TypecheckTarget } from "../targets";
export type ToolVersions = Record<string, string>;
export interface TypecheckOperationContext {
  /** All workspace members of one manager owner; caller already holds the lease. */
  targets: TypecheckTarget[];
  versions: Record<string, ToolVersions>;
  policy: TypecheckPolicy;
  signal: AbortSignal;
  changes: PreparationChange[];
}
export interface TypecheckCheckContext {
  target: TypecheckTarget;
  versions: ToolVersions;
  policy: TypecheckPolicy;
  projection: ProjectionPlan;
  signal: AbortSignal;
}
export type TypecheckToolContext = Omit<TypecheckCheckContext, "projection">;
export interface TypecheckAdapter {
  /** Once per Python/JS discovery wave, one exact common version for every member. */
  resolve(
    targets: TypecheckTarget[],
    policy: TypecheckPolicy,
    signal: AbortSignal,
  ): Promise<Record<string, ToolVersions>>;
  preflight(context: TypecheckOperationContext): Promise<void>;
  prepareBatch(context: TypecheckOperationContext): Promise<void>;
  /** Tools/declarations/lock verification independent of native policy projection. */
  verifyTools(context: TypecheckToolContext): Promise<boolean>;
  /** Read-only; may inspect installed native tooling. Called after tool provisioning. */
  plan(
    target: TypecheckTarget,
    policy: TypecheckPolicy,
    signal: AbortSignal,
  ): Promise<ProjectionPlan>;
  check(context: TypecheckCheckContext): Promise<TypecheckCheck[]>;
}
export type TypecheckAdapterRegistry = Readonly<
  Partial<Record<TypecheckEcosystem, TypecheckAdapter>>
>;
