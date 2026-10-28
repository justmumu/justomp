import { expect, test } from "bun:test";
import { yarnModernAdapter as adapter } from "../../../../src/dependencies/adapters/yarn-modern";
import { fixture } from "./yarn-bun-fixture";

test("Yarn modern native registry lifecycle respects constraints and exact downgrades", async () => {
  const f = await fixture("modern");
  try {
    await f.operate(adapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [
        { name: "u6-dep", version: "^1.0.0", source: { kind: "registry" } },
      ],
    });
    const graph = await adapter.inventory(await f.context(), true);
    expect(graph.complete).toBe(true);
    expect(
      graph.dependencies.some((d) => d.name === "u6-child" && !d.direct),
    ).toBe(true);
    expect(await f.installed("u6-dep")).toBe("1.0.0");
    f.publish("2.0.0");
    await f.operate(adapter, {
      operation: "update",
      packages: [{ name: "u6-dep" }],
    });
    expect((await f.manifest()).dependencies["u6-dep"]).toBe("^1.0.0");
    expect(await f.installed("u6-dep")).toBe("1.1.0");
    await f.operate(adapter, {
      operation: "update",
      mode: "latest",
      packages: [{ name: "u6-dep" }],
    });
    expect((await f.manifest()).dependencies["u6-dep"]).toContain("2.0.0");
    expect(await f.installed("u6-dep")).toBe("2.0.0");
    await f.operate(adapter, {
      operation: "update",
      packages: [{ name: "u6-dep", version: "1.0.0" }],
    });
    expect(await f.installed("u6-dep")).toBe("1.0.0");
    expect((await f.manifest()).dependencies["u6-dep"]).toBe("1.0.0");
    await f.operate(adapter, { operation: "sync" });
    await f.operate(adapter, {
      operation: "remove",
      group: { kind: "runtime" },
      packages: [{ name: "u6-dep" }],
    });
    expect((await f.manifest()).dependencies?.["u6-dep"]).toBeUndefined();
  } finally {
    await f.close();
  }
}, 60000);

import { nativeScenarios } from "./yarn-bun-scenarios";

nativeScenarios("modern", adapter);

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

test("modern Yarn node_modules linker shares the same native graph contract as PnP", async () => {
  const f = await fixture("modern");
  try {
    await appendFile(join(f.root, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    await f.operate(adapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [
        { name: "u6-dep", version: "1.0.0", source: { kind: "registry" } },
      ],
    });
    expect(
      JSON.parse(
        await readFile(
          join(f.root, "node_modules/u6-dep/package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("1.0.0");
    expect((await adapter.inventory(await f.context(), true)).complete).toBe(
      true,
    );
    await f.operate(adapter, { operation: "sync" });
  } finally {
    await f.close();
  }
}, 60000);
