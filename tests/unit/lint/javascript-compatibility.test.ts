import { expect, test } from "bun:test";
import { validateCompatibility } from "../../../src/lint/javascript/compatibility";

test("Biome compatibility checks native runtime, without application compiler or framework coupling", () => {
  const metadata = {
    "@biomejs/biome": {
      name: "@biomejs/biome",
      version: "2.6.3",
      engines: { node: ">=14.21.3" },
    },
  };
  const tools = { "@biomejs/biome": "2.6.3" };
  expect(() => validateCompatibility(metadata, tools, "26.0.0")).not.toThrow();
  expect(() => validateCompatibility(metadata, tools, "12.0.0")).toThrow(
    "incompatible",
  );
});
