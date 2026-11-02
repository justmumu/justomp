import { expect, test } from "bun:test";
import { measuredVersion } from "../../fixtures/dependencies/measured-version";

test("native fixture version guard rejects a mismatched launcher result", () => {
  const result = {
    exit_code: 0,
    signal: null,
    stdout: "0.0.0\n",
    stderr: "",
    cancelled: false,
    truncated: false,
  };
  expect(() => measuredVersion("pnpm", "10.20.0", result)).toThrow("Native pnpm test requires 10.20.0; measured 0.0.0");
  expect(measuredVersion("pnpm", "10.20.0", { ...result, stdout: "10.20.0\n" })).toBe("10.20.0");
});
