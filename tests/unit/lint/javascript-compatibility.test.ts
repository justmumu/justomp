import { expect, test } from "bun:test";
import { validateCompatibility } from "../../../src/lint/javascript/compatibility";

test("project-owned TypeScript compatibility still enforces its Node runtime requirement", () => {
  const metadata = {
    typescript: {
      name: "typescript",
      version: "7.0.2",
      engines: { node: ">=20.1.0" },
    },
  };
  const tools = { typescript: "7.0.2" };
  expect(() => validateCompatibility(metadata, tools, "26.0.0")).not.toThrow();
  expect(() => validateCompatibility(metadata, tools, "12.0.0")).toThrow("incompatible");
});
