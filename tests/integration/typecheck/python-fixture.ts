import { pythonFixture } from "../../fixtures/typecheck/python/fixture";
export const cleanups: (() => Promise<void>)[] = [];
export async function fixture(workspace = false, declaration = "") {
  const f = await pythonFixture(workspace, declaration);
  cleanups.push(f.dispose);
  return f;
}
