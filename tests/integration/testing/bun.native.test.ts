import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bunTestAdapter } from "../../../src/testing/javascript/bun";
import { nativeFixture } from "./native-fixture";

test("Bun exact selection reports pass/fail and imports unused sources in global teardown without fake tests", async () => {
  const f = await nativeFixture("bun", bunTestAdapter);
  try {
    await f.put(
      "bunfig.toml",
      '[test]\ncoverageThreshold=1\npreload=["./setup.ts"]\n',
    );
    await f.put("setup.ts", "globalThis.nativeSetup = true;");
    await f.put(
      "src/unused.ts",
      `await Bun.write(${JSON.stringify(join(f.root, "sentinel"))},'imported');\nexport function unused() {\n return 42;\n}\n`,
    );
    await f.put(
      "chosen.test.ts",
      "import {test,expect} from 'bun:test'; test('fails',()=>expect(1).toBe(2)); test('passes',()=>expect(globalThis.nativeSetup).toBe(true));",
    );
    await f.put(
      "chosen.test.ts.other.test.ts",
      "throw new Error('foreign test executed');",
    );
    const full = await f.run(["chosen.test.ts"], ["src/unused.ts"]);
    expect(full.errors).toEqual([
      { code: "test-failed", message: "One or more tests failed" },
    ]);
    expect(full.tests).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(full.executed_files).toEqual(["chosen.test.ts"]);
    expect(full.coverage?.total).toBeGreaterThan(0);
    expect(await readFile(join(f.root, "sentinel"), "utf8")).toBe("imported");
    await f.put(
      "chosen.test.ts",
      "import {test,expect} from 'bun:test'; test('passes',()=>expect(globalThis.nativeSetup).toBe(true));",
    );
    const targeted = await f.run(
      ["chosen.test.ts"],
      ["missing.ts"],
      "targeted",
    );
    expect(targeted.errors).toEqual([]);
    expect(targeted.tests.passed).toBe(1);
    expect(targeted.coverage).toBeUndefined();
    await f.put(
      "src/mocked.ts",
      "export function neverLoaded() { return 42; }",
    );
    await f.put(
      "chosen.test.ts",
      "import {test,mock} from 'bun:test'; mock.module('./src/mocked.ts',()=>({neverLoaded:()=>0}));test('passes',()=>{});",
    );
    const mocked = await f.run(["chosen.test.ts"], ["src/mocked.ts"]);
    expect(mocked.tests.passed).toBe(1);
    expect(mocked.coverage).toBeUndefined();
    expect(mocked.errors).toContainEqual({
      code: "invalid-report",
      message: "Coverage missing source: src/mocked.ts",
    });
  } finally {
    await f.dispose();
  }
}, 60000);
