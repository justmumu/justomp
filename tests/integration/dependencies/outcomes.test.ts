import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Adapter } from "../../../src/dependencies/model";
import { executeDependency } from "../../../src/dependencies/service";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { suppliedResponse } from "../../response";
import { fixture, roots } from "./outcomes-fixture";

afterEach(async () => {
  await closePackagingStructure();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
test("cancelled native list cannot become successful incomplete inventory", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "npm@11.12.1",
      scripts: { wait: "node wait.cjs" },
    }),
  );
  await writeFile(join(root, "wait.cjs"), 'require("node:fs").writeFileSync("ready","yes");setInterval(()=>{},1000);');
  const controller = new AbortController();
  const adapter: Adapter = {
    groups: ["runtime"],
    inventory: async (ctx) => {
      const result = await ctx.run({
        args: ["run", "wait"],
        label: "native graph",
      });
      expect(result.cancelled).toBe(true);
      return { dependencies: [], complete: false, diagnostics: [] };
    },
    plan: () => {
      return suppliedResponse(() => {
        throw new Error("list only");
      });
    },
  };
  const operation = executeDependency(
    root,
    "list",
    { project_id: "javascript:package.json", include_transitive: true },
    { npm: adapter },
    controller.signal,
  );
  try {
    const deadline = Date.now() + 10000;
    while (!(await Bun.file(join(root, "ready")).exists())) {
      if (Date.now() > deadline) {
        throw new Error("native graph did not start");
      }
      await Bun.sleep(10);
    }
    controller.abort();
    expect((await operation).outcome).toBe("cancelled");
  } finally {
    controller.abort();
    await operation;
  }
}, 15000);
