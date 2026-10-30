import type {
  TypecheckAdapter,
  TypecheckCheckContext,
} from "../../../src/typecheck/adapters/types";
export async function projectionCurrent(
  adapter: TypecheckAdapter,
  context: TypecheckCheckContext,
) {
  return (await adapter.plan(context.target, context.policy, context.signal))
    .current;
}
