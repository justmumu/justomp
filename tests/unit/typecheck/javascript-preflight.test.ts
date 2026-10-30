import { expect, spyOn, test } from "bun:test";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import * as compatibility from "../../../src/lint/javascript/compatibility";
import * as runtime from "../../../src/lint/runtime";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import type { TypecheckOperationContext } from "../../../src/typecheck/adapters/types";
import { target } from "../checks/fixture";
import { memoryContext } from "../dependencies/memory";

for (const variant of ["runtime", "override", "group"] as const)
  test(`TypeScript ${variant} conflict fails preflight before native work`, async () => {
    const f = memoryContext();
    f.write(
      "package.json",
      JSON.stringify({
        name: "app",
        ...(variant === "group"
          ? { dependencies: { typescript: "5.9.3" } }
          : { devDependencies: { typescript: "5.9.3" } }),
        ...(variant === "override"
          ? { overrides: { typescript: "5.9.3" } }
          : {}),
      }),
    );
    const selected = target("javascript");
    Object.assign(selected, {
      root: f.root,
      project: f.context.project,
      structure: f.context.structure,
    });
    Object.assign(selected.scope, {
      cwd: f.context.cwd,
      owner: f.context.owner,
    });
    const context: TypecheckOperationContext = {
      targets: [selected],
      versions: { [selected.project.project_id]: { typescript: "7.0.2" } },
      policy: resolveTypecheckConfig().policy,
      signal: new AbortController().signal,
      changes: [],
    };
    const probe = spyOn(runtime, "lintManagerContext").mockResolvedValue(
      f.context,
    );
    const node = spyOn(compatibility, "nodeVersion").mockResolvedValue(
      "24.0.0",
    );
    const metadata = spyOn(compatibility, "toolMetadata").mockResolvedValue({
      typescript: {
        name: "typescript",
        version: "7.0.2",
        engines: { node: variant === "runtime" ? ">=999" : ">=20" },
      },
    });
    const run = spyOn(f.context, "run");
    const before = [...f.files];
    try {
      await expect(javascriptAdapter.preflight(context)).rejects.toMatchObject({
        name: "TypecheckError",
        code:
          variant === "group"
            ? "conflicting-declaration"
            : "incompatible-toolchain",
      });
      expect(context.changes).toEqual([]);
      expect([...f.files]).toEqual(before);
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
      metadata.mockRestore();
      node.mockRestore();
      probe.mockRestore();
      f.close();
    }
  });
