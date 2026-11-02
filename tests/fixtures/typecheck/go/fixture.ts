import { resolveTypecheckConfig } from "../../../../src/config/typecheck/resolve";
import { goAdapter } from "../../../../src/typecheck/adapters/go";
import { type TypecheckOperationContext } from "../../../../src/typecheck/adapters/types";
import { goFixture as nativeFixture } from "../../lint/go/fixture";

export async function goFixture(workspace = false) {
  const native = await nativeFixture(workspace);
  const policy = resolveTypecheckConfig().policy;
  const signal = native.context.signal;
  const context: TypecheckOperationContext = {
    targets: native.targets,
    policy,
    signal,
    changes: [],
    versions: await goAdapter.resolve(native.targets, policy, signal),
  };
  return {
    ...native,
    context,
    async checkContext(index = 0) {
      const target = native.targets[index];
      if (!target) {
        throw new Error("Missing Go fixture target");
      }
      return {
        target,
        policy,
        signal,
        versions: context.versions[target.project.project_id] ?? {},
        projection: await goAdapter.plan(target, policy, signal),
      };
    },
    async prepare() {
      await goAdapter.preflight(context);
      await goAdapter.prepareBatch(context);
    },
  };
}
