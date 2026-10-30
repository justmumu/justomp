import { expect, test } from "bun:test";
import { validateCompatibility } from "../../../src/lint/javascript/compatibility";

test("preflight compatibility rejects unsupported application TypeScript", () => {
  const metadata = {
    "typescript-eslint": {
      name: "typescript-eslint",
      version: "8.72.1",
      peerDependencies: { typescript: ">=4.8.4 <6.0.0" },
    },
  };
  const tools = {
    eslint: "9.39.5",
    "@eslint/js": "9.39.5",
    "typescript-eslint": "8.72.1",
  };
  expect(() =>
    validateCompatibility(metadata, tools, { typescript: "7.0.2" }, "24.0.0"),
  ).toThrow("incompatible");
});
