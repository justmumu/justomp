import { expect, test } from "bun:test";
import { npmAdapter } from "../../../src/dependencies/adapters/npm";
import { memoryContext } from "./memory";

async function lockedInventory(declarations: Record<string, string>) {
  const f = memoryContext();
  f.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      packageManager: "npm@11.12.1",
      devDependencies: { typescript: "7.0.2", "@types/node": "24.10.1" },
    }),
  );
  f.write(
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", devDependencies: declarations },
        "node_modules/typescript": { version: "7.0.2" },
        "node_modules/@types/node": { version: "24.10.1" },
      },
    }),
  );
  try {
    return await npmAdapter.inventory(f.context, false);
  } finally {
    f.close();
  }
}
test("npm lock declaration equality ignores native key ordering", async () => {
  const result = await lockedInventory({
    "@types/node": "24.10.1",
    typescript: "7.0.2",
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.complete).toBe(true);
  expect(
    result.dependencies.every((item) => item.resolutions?.length === 1),
  ).toBe(true);
});
const staleDeclarations: Record<string, Record<string, string>> = {
  changed: { "@types/node": "24.10.1", typescript: "5.9.3" },
  missing: { typescript: "7.0.2" },
  extra: { "@types/node": "24.10.1", typescript: "7.0.2", extra: "1.0.0" },
};
for (const [name, declarations] of Object.entries(staleDeclarations))
  test(`npm lock still rejects ${name} declarations`, async () => {
    const result = await lockedInventory(declarations);
    expect(
      result.diagnostics.some((item) =>
        item.message.includes("npm lock declarations are stale"),
      ),
    ).toBe(true);
  });
