import type { Adapter } from "../model";
import { groups, nativeInventory, plan, verify } from "./yarn-common";
export const yarnModernAdapter: Adapter = {
  groups,
  plan: (context, request, inventory) =>
    plan(context, request, inventory, "modern"),
  inventory: (context, transitive) =>
    nativeInventory(context, transitive, "modern"),
  verify,
};
