import { pythonFixture } from "../../fixtures/lint/python/fixture";
export const cleanups: (() => Promise<void>)[] = [];
export async function fixture(workspace = false, declaration = "") {
  const value = await pythonFixture(workspace, declaration);
  cleanups.push(value.dispose);
  return value;
}
