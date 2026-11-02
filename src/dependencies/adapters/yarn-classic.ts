import { type Adapter } from "../model";
import { groups, nativeInventory, plan, verify } from "./yarn-common";
export const yarnClassicAdapter: Adapter = {
  groups,
  plan: (context, request, inventory) => plan(context, request, inventory, "classic"),
  inventory: (context, transitive) => nativeInventory(context, transitive, "classic"),
  verify,
};
