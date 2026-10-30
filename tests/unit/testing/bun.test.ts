import { expect, test } from "bun:test";
import { bunConfig, bunPreload } from "../../../src/testing/javascript/config";
import { coverageEnabled } from "../../../src/testing/native-tools";
import { context } from "./fixture";

test("Bun preserves native setup and unrelated settings, replacing native coverage gate", () => {
  const c = context(),
    config = bunConfig(
      c,
      {
        jsx: "react",
        test: {
          preload: ["./setup.ts"],
          coverageThreshold: { lines: 1 },
          timeout: 9000,
        },
      },
      "/reports/preload.ts",
    );
  expect(config).toMatchObject({
    jsx: "react",
    test: {
      preload: ["./setup.ts", "/reports/preload.ts"],
      timeout: 9000,
      coverageThreshold: 0,
    },
  });
  expect(bunPreload(c)).toContain("afterAll(");
  expect(bunPreload(c)).toContain("12345");
  expect(bunPreload(c)).not.toContain("test(");
  expect(coverageEnabled(context("targeted"))).toBe(false);
  c.policy.coverage.enabled = false;
  expect(coverageEnabled(c)).toBe(false);
});
