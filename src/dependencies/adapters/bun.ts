import type { Adapter } from "../model";
import { groups, nativeInventory, plan, verify } from "./yarn-common";
export const bunAdapter: Adapter = {
  groups,
  plan: (context, request, inventory) =>
    plan(context, request, inventory, "bun"),
  inventory: (context, transitive) =>
    nativeInventory(context, transitive, "bun"),
  verify,
};
