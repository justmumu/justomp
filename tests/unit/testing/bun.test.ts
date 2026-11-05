import { expect, test } from "bun:test";
import { bunConfig, bunPreload } from "../../../src/testing/javascript/config";
import { coverageEnabled } from "../../../src/testing/native-tools";
import { context } from "./fixture";

test("Bun preserves native setup and unrelated settings, replacing native coverage gate", () => {
  const c = context(),
    config = bunConfig({
      jsx: "react",
      test: {
        preload: ["./setup.ts"],
        coverageThreshold: { lines: 1 },
        timeout: 9000,
      },
    });
  expect(config).toMatchObject({
    jsx: "react",
    test: {
      preload: ["./setup.ts"],
      timeout: 9000,
      coverageThreshold: 0,
    },
  });
  expect(config.test).not.toHaveProperty("coverage");
  expect(JSON.stringify(config)).not.toContain("/reports/");
  expect(bunPreload(c)).toContain("afterAll(");
  expect(bunPreload(c)).toContain("12345");
  expect(bunPreload(c)).not.toContain("test(");
  expect(coverageEnabled(context("targeted"))).toBe(false);
  c.policy.coverage.enabled = false;
  expect(coverageEnabled(c)).toBe(false);
});
