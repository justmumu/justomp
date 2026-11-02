import { spyOn } from "bun:test";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { pythonFixture, VERSION } from "../../fixtures/typecheck/python/fixture";
export const cleanup: (() => Promise<void>)[] = [];
export async function fixture(workspace = false) {
  const f = await pythonFixture(workspace);
  cleanup.push(async () => {
    await closePackagingStructure(f.root);
    await f.dispose();
  });
  return f;
}
export function registry() {
  const original = globalThis.fetch;
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        if (String(input) !== "https://pypi.org/pypi/pyright/json") {
          throw new Error(`Unexpected network: ${input}`);
        }
        return Response.json({ releases: { [VERSION]: [{ yanked: false }] } });
      },
      { preconnect: original.preconnect },
    ),
  );
}
export const id = "python:pyproject.toml";
