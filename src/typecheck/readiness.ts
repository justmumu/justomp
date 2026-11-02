import { type TypecheckAdapter, type TypecheckToolContext } from "./adapters/types";
import { type ProjectionPlan } from "./projection";

/** Re-read policy projection after tool probes; callers run this on both sides of work. */
export async function readyTypecheckProjection(
  adapter: Pick<TypecheckAdapter, "verifyTools" | "plan">,
  context: TypecheckToolContext,
): Promise<ProjectionPlan | undefined> {
  const { target, policy, signal } = context;
  signal.throwIfAborted();
  const toolsReady = await adapter.verifyTools(context);
  signal.throwIfAborted();
  if (!toolsReady) {
    return undefined;
  }
  const projection = await adapter.plan(target, policy, signal);
  signal.throwIfAborted();
  return projection.current ? projection : undefined;
}
