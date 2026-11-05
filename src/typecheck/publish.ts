import { type PreparationChange } from "./model";
import { applyProjection, type ProjectionPlan, retireProjection } from "./projection";
import { type TypecheckStateStore } from "./state";

/** All plans are preflighted by the caller before any native file is published. */
export async function publishTypecheckProjections(
  plans: readonly ProjectionPlan[],
  store: TypecheckStateStore,
  changes: PreparationChange[],
): Promise<void> {
  for (const plan of plans) {
    const receipt = store.state.projects[plan.target.project.project_id];
    if (receipt && !plan.current) {
      receipt.ready = false;
    }
  }
  await store.save();
  for (const plan of plans) {
    await applyProjection(plan, changes);
    const receipt = store.state.projects[plan.target.project.project_id];
    if (receipt && plan.native_configs) {
      receipt.native_configs = plan.native_configs;
    }
  }
  await store.save();
  for (const plan of plans) {
    await retireProjection(plan, changes);
  }
}
