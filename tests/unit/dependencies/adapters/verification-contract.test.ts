import { expect, test } from "bun:test";
import { verifyJs } from "../../../../src/dependencies/adapters/js-common";
import { uvAdapter } from "../../../../src/dependencies/adapters/uv";
import { verify as verifyYarn } from "../../../../src/dependencies/adapters/yarn-common";
import { type Inventory } from "../../../../src/dependencies/model";
import { context } from "./npm-pnpm-fixture";

for (const [name, verify] of [
  ["JavaScript", verifyJs],
  ["Yarn/Bun", verifyYarn],
  ["uv", uvAdapter.verify],
] as const) {
  test(`${name} verification failures reject instead of throwing at invocation`, async () => {
    if (!verify) {
      throw new Error("Missing verifier");
    }
    const inventory: Inventory = { dependencies: [], complete: true, diagnostics: [] };
    const result = verify(
      context("npm"),
      {
        operation: "update",
        project_id: "supplied",
        packages: [{ name: "absent", version: "1.0.0" }],
      },
      inventory,
      inventory,
    );
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toMatchObject({ code: "dependency-not-found" });
  });
}
