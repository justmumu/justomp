import { javascriptFixture, type Manager } from "../../fixtures/lint/javascript/fixture";
export const cleanups: (() => Promise<void>)[] = [];
export async function fixture(
  manager: Manager = "npm",
  flavor: "js" | "ts" | "react" | "next" = "js",
  workspace = false,
) {
  const f = await javascriptFixture(manager, flavor, workspace);
  cleanups.push(f.dispose);
  return f;
}
