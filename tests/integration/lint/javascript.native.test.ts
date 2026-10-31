import { afterEach, expect, test } from "bun:test";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatPrettier,
  prettierVersion,
} from "../../../src/format/engines/prettier";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import { cleanups, fixture } from "./javascript-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
for (const manager of ["npm", "yarn-modern"] as const)
  test(`native ${manager} loads managed typed plugins and returns readonly lint/format diagnostics`, async () => {
    const f = await fixture(manager, "next");
    await f.prepare();
    const ctx = await f.checkContext();
    expect(await javascriptAdapter.verify(ctx)).toBe(true);
    expect(
      JSON.parse(await readFile(join(f.root, "package.json"), "utf8"))
        .devDependencies.prettier,
    ).toBeUndefined();
    expect(
      JSON.parse(await readFile(join(f.root, "package.json"), "utf8"))
        .devDependencies.typescript,
    ).toBe("5.9.3");
    if (manager === "npm") {
      await writeFile(
        join(f.root, "eslint.config.mjs"),
        "export default [];\n",
      );
      await writeFile(
        join(f.root, ".prettierrc"),
        '{"singleQuote":true,"semi":false}',
      );
      await writeFile(join(f.root, ".prettierignore"), "index.ts\n");
      await writeFile(
        join(f.root, ".editorconfig"),
        "root = true\n[*]\nindent_size = 8\n",
      );
    }
    expect((await javascriptAdapter.check(ctx)).map((c) => c.status)).toEqual([
      "passed",
      "passed",
    ]);
    await writeFile(join(f.root, "index.ts"), "Promise.resolve(1)\n");
    await writeFile(
      join(f.root, "component.tsx"),
      "export const component = <div />;\n",
    );
    const before = await f.bytes();
    const checks = await javascriptAdapter.check(await f.checkContext());
    expect(checks.map((c) => c.status)).toEqual(["failed", "failed"]);
    expect(checks[0]?.diagnostics).toContainEqual(
      expect.objectContaining({
        project_path: "index.ts",
        rule: "@typescript-eslint/no-floating-promises",
      }),
    );
    expect(checks[1]?.diagnostics).toContainEqual(
      expect.objectContaining({ project_path: "index.ts" }),
    );
    expect(await f.bytes()).toEqual(before);
    expect(checks[1]?.version).toBe(prettierVersion);
    if (manager === "npm") {
      const source = await readFile(join(f.root, "index.ts"), "utf8");
      await writeFile(
        join(f.root, "index.ts"),
        await formatPrettier(
          source,
          "typescript",
          ctx.policy.javascript.prettier,
        ),
      );
      expect((await javascriptAdapter.check(ctx))[1]?.status).toBe("passed");
      await unlink(join(f.root, "node_modules/eslint/bin/eslint.js"));
      expect(await javascriptAdapter.verify(await f.checkContext())).toBe(
        false,
      );
      expect(
        (await javascriptAdapter.check(await f.checkContext()))[0]?.status,
      ).toBe("not-run");
    }
  }, 180000);
