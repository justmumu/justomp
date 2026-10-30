import { expect, test } from "bun:test";
import { nextWave } from "../../../src/testing/state";

test("new cohorts refresh once while partial waves keep exact targets and pending discoveries", () => {
  expect(nextWave(undefined, ["a"])).toEqual({
    resolve: true,
    projects: ["a"],
    pending: [],
  });
  const partial = {
    projects: ["a"],
    tools: { pytest: "9.1.0" },
    complete: false,
    pending: [],
  };
  expect(nextWave(partial, ["a", "b"])).toEqual({
    resolve: false,
    projects: ["a"],
    pending: ["b"],
  });
  expect(nextWave({ ...partial, complete: true }, ["a"])).toEqual({
    resolve: false,
    projects: ["a"],
    pending: [],
  });
  expect(nextWave({ ...partial, complete: true }, ["a", "b"])).toEqual({
    resolve: true,
    projects: ["a", "b"],
    pending: [],
  });
  expect(
    nextWave({ ...partial, projects: ["a", "removed"], complete: true }, ["a"]),
  ).toEqual({ resolve: false, projects: ["a"], pending: [] });
});
