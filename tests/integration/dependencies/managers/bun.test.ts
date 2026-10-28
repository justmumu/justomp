import { expect, test } from "bun:test";
import { bunAdapter as adapter } from "../../../../src/dependencies/adapters/bun";
import { fixture } from "./yarn-bun-fixture";

test("Bun native registry lifecycle respects constraints and exact downgrades", async () => {
  const f = await fixture("bun");
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
    expect((await f.manifest()).dependencies["u6-dep"]).toBe("^1.1.0");
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

nativeScenarios("bun", adapter);

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("Bun binary lock graph and frozen sync retain native binary metadata", async () => {
  const f = await fixture("bun");
  try {
    await writeFile(
      join(f.root, "bunfig.toml"),
      "[install]\nsaveTextLockfile = false\n",
    );
    await f.operate(adapter, {
      operation: "add",
      group: { kind: "runtime" },
      packages: [
        { name: "u6-dep", version: "1.0.0", source: { kind: "registry" } },
      ],
    });
    const before = await readFile(join(f.root, "bun.lockb"));
    const graph = await adapter.inventory(await f.context(), true);
    expect(graph.complete).toBe(true);
    expect(
      graph.dependencies.find((d) => d.name === "u6-child")?.resolutions?.[0]
        ?.version,
    ).toBe("1.0.0");
    expect(await readFile(join(f.root, "bun.lockb"))).toEqual(before);
    await f.operate(adapter, { operation: "sync" });
    expect(await readFile(join(f.root, "bun.lockb"))).toEqual(before);
  } finally {
    await f.close();
  }
}, 60000);
