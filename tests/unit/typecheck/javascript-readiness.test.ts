import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { type Adapter, type Inventory } from "../../../src/dependencies/model";
import * as compatibility from "../../../src/lint/javascript/compatibility";
import * as native from "../../../src/lint/javascript/native";
import * as runtime from "../../../src/lint/runtime";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import { output, target } from "../checks/fixture";
import { memoryContext } from "../dependencies/memory";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture() {
  const f = memoryContext();
  restores.push(f.close);
  const selected = target("javascript");
  Object.assign(selected, {
    root: f.root,
    project: f.context.project,
    structure: f.context.structure,
  });
  Object.assign(selected.scope, { cwd: f.context.cwd, owner: f.context.owner });
  const inventory: Inventory = {
    complete: true,
    diagnostics: [],
    dependencies: [
      {
        name: "typescript",
        direct: true,
        group: { kind: "dev" },
        source: { kind: "registry" },
        declared_specifier: "7.0.2",
        resolutions: [{ version: "7.0.2", evidence: "lock" }],
        evidence: { file: "package.json", field: "devDependencies.typescript" },
      },
    ],
  };
  const adapter: Adapter = {
    groups: ["dev"],
    plan: async () => {
      throw new Error("readonly verification cannot plan mutations");
    },
    inventory: async () => inventory,
  };
  keep(spyOn(runtime, "lintManagerContext").mockResolvedValue(f.context));
  keep(spyOn(native, "nativeAdapter").mockReturnValue(adapter));
  keep(spyOn(compatibility, "nodeVersion").mockResolvedValue("26.0.0"));
  const metadata = keep(
    spyOn(native, "installedPackages").mockResolvedValue({
      typescript: {
        name: "typescript",
        version: "7.0.2",
        engines: { node: ">=20" },
      },
    }),
  );
  const run = keep(spyOn(native, "localTool").mockResolvedValue(output({ stdout: "Version 7.0.2\n" })));
  const network = keep(
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("readonly verification cannot download")),
  );
  const context = {
    target: selected,
    signal: new AbortController().signal,
    versions: { typescript: "7.0.2" },
    policy: resolveTypecheckConfig().policy,
  };
  return {
    inventory,
    metadata,
    run,
    network,
    check: () => javascriptAdapter.verifyTools(context),
  };
}
test("TypeScript readiness requires the declared, resolved, installed and executable version to agree", async () => {
  const f = fixture();
  expect(await f.check()).toBe(true);
  f.run.mockResolvedValue(output({ stdout: "Version 5.9.3\n" }));
  expect(await f.check()).toBe(false);
  f.run.mockRejectedValue(new Error("Missing local binary for typescript"));
  expect(await f.check()).toBe(false);
  expect(f.network).not.toHaveBeenCalled();
});
test("changed compiler declaration invalidates readiness before launching the installed executable", async () => {
  const f = fixture();
  const dependency = f.inventory.dependencies[0];
  if (!dependency) {
    throw new Error("Missing supplied declaration");
  }
  dependency.declared_specifier = "5.9.3";
  expect(await f.check()).toBe(false);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.metadata).not.toHaveBeenCalled();
});
