import { expect, test } from "bun:test";
import { releaseSchemas } from "../../../src/release/schemas";

test("release tools accept only explicit increment and empty read inputs", () => {
  for (const increment of ["patch", "minor", "major"] as const) {
    expect(releaseSchemas.bump.parse({ increment })).toEqual({ increment });
  }
  for (const input of [{}, { increment: "auto" }, { increment: "1.2.3" }, { increment: "patch", project_id: "x" }]) {
    expect(() => releaseSchemas.bump.parse(input)).toThrow();
  }
  expect(releaseSchemas.changelog.parse({})).toEqual({});
  expect(releaseSchemas.tag.parse({})).toEqual({});
  expect(() => releaseSchemas.tag.parse({ force: true })).toThrow();
  expect(() => releaseSchemas.changelog.parse({ project_id: "x" })).toThrow();
});
