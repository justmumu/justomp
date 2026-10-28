import { npmAdapter } from "../../../../src/dependencies/adapters/npm";
import { managerCases } from "./npm-pnpm-cases";

managerCases("npm", npmAdapter);

import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitCases } from "./npm-pnpm-cases";
import { fixture } from "./npm-pnpm-fixture";

gitCases("npm", npmAdapter);
test("npm failed installation retains completed native declaration removal", async () => {
  const f = await fixture("npm");
  try {
    const manifest = await f.manifest();
    manifest.dependencies = {
      "fixture-dep": "1.0.0",
      "not-in-registry": "1.0.0",
    };
    await writeFile(join(f.project, "package.json"), JSON.stringify(manifest));
    const ctx = await f.context();
    const before = await npmAdapter.inventory(ctx, false);
    const plan = await npmAdapter.plan(
      ctx,
      {
        operation: "remove",
        project_id: ctx.project.project_id,
        group: { kind: "runtime" },
        packages: [{ name: "fixture-dep" }],
      },
      before,
    );
    expect(plan.steps).toHaveLength(2);
    const [declaration, install] = plan.steps;
    if (!declaration || !install)
      throw new Error("Expected both native stages");
    expect((await ctx.run(declaration)).exit_code).toBe(0);
    expect((await ctx.run(install)).exit_code).not.toBe(0);
    expect((await f.manifest()).dependencies["fixture-dep"]).toBeUndefined();
    expect((await f.manifest()).dependencies["not-in-registry"]).toBe("1.0.0");
  } finally {
    await f.close();
  }
}, 60000);
