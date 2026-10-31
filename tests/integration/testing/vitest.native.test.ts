import { expect, test } from "bun:test";
import { vitestTestAdapter } from "../../../src/testing/javascript/vitest";
import { nativeFixture } from "./native-fixture";

test("Vitest exact escaped include preserves native setup and ignores sibling projects and native thresholds", async () => {
  const f = await nativeFixture("vitest", vitestTestAdapter);
  try {
    await f.put(
      "vitest.config.ts",
      "export default {test:{setupFiles:['./setup.ts'],projects:['sibling'],retry:2,bail:1,coverage:{thresholds:{lines:100,functions:100,perFile:true}}}};",
    );
    await f.put("setup.ts", "globalThis.nativeSetup=true;");
    await f.put(
      "src/unused.ts",
      "export function unused() {\n return 42;\n}\n",
    );
    await f.put(
      "chosen[one].test.ts",
      "import {test,expect} from 'vitest';test('fails',()=>expect(1).toBe(2));test('passes',()=>expect(globalThis.nativeSetup).toBe(true));",
    );
    await f.put("chosenx.test.ts", "throw new Error('foreign test executed');");
    const full = await f.run(["chosen[one].test.ts"], ["src/unused.ts"]);
    expect(full.errors).toEqual([
      { code: "test-failed", message: "One or more tests failed" },
    ]);
    expect(full.tests).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(full.coverage?.total).toBeGreaterThan(0);
    expect(full.coverage?.covered).toBe(0);
    await f.put(
      "integration.config.ts",
      "export default {test:{setupFiles:['./integration-setup.ts'],coverage:{enabled:true}}};",
    );
    await f.put("integration-setup.ts", "globalThis.integrationSetup=true;");
    await f.put(
      "tests/integration/flow.test.ts",
      "import {test,expect} from 'vitest';test('flow',()=>expect(globalThis.integrationSetup).toBe(true));",
    );
    const integration = await f.run(
      ["tests/integration/flow.test.ts"],
      ["src/unused.ts"],
      "full",
      { suite: "integration", configFile: "integration.config.ts" },
    );
    expect(integration.errors).toEqual([]);
    expect(integration.tests).toMatchObject({ total: 1, passed: 1 });
    expect(integration.coverage).toBeUndefined();
  } finally {
    await f.dispose();
  }
}, 60000);
