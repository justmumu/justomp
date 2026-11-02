import { expect, test } from "bun:test";
import { yarnClassicAdapter as adapter } from "../../../../src/dependencies/adapters/yarn-classic";
import { fixture } from "./yarn-bun-fixture";

test("Yarn Classic native registry lifecycle respects constraints and exact downgrades", async () => {
  const f = await fixture("classic");
  try {
    await f.operate(adapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [{ name: "u6-dep", version: "^1.0.0", source: { kind: "registry" } }],
    });
    const graph = await adapter.inventory(await f.context(), true);
    expect(graph.complete).toBe(true);
    expect(graph.dependencies.some((d) => d.name === "u6-child" && !d.direct)).toBe(true);
    expect(await f.installed("u6-dep")).toBe("1.0.0");
    f.publish("2.0.0");
    await f.operate(adapter, {
      operation: "update",
      packages: [{ name: "u6-dep" }],
    });
    expect((await f.manifest()).dependencies?.["u6-dep"]).toBe("^1.0.0");
    expect(await f.installed("u6-dep")).toBe("1.1.0");
    await f.operate(adapter, {
      operation: "update",
      mode: "latest",
      packages: [{ name: "u6-dep" }],
    });
    expect((await f.manifest()).dependencies?.["u6-dep"]).toContain("2.0.0");
    expect(await f.installed("u6-dep")).toBe("2.0.0");
    await f.operate(adapter, {
      operation: "update",
      packages: [{ name: "u6-dep", version: "v1.0.0" }],
    });
    expect(await f.installed("u6-dep")).toBe("1.0.0");
    expect((await f.manifest()).dependencies?.["u6-dep"]).toBe("1.0.0");
    await f.operate(adapter, { operation: "sync", check: true });
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

nativeScenarios("classic", adapter);
