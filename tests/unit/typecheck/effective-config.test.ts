import { expect, test } from "bun:test";
import { effectiveJavascriptConfig } from "../../../src/typecheck/javascript/config-graph";
import { output } from "../checks/fixture";

const path = "/repo/tsconfig.json";
test("effective compiler metadata parses without a native installation", () => {
  expect(
    effectiveJavascriptConfig(
      output({
        stdout: '{"compilerOptions":{"strict":true},"files":["a.ts"]}',
      }),
      {},
      path,
    ),
  ).toEqual({ compilerOptions: { strict: true }, files: ["a.ts"] });
});
test("malformed showConfig metadata is rejected", () => {
  expect(() =>
    effectiveJavascriptConfig(
      output({ stdout: "unexpected compiler output\n{}" }),
      {},
      path,
    ),
  ).toThrow("invalid --showConfig metadata");
});
test("empty native configuration retains its options only for a complete no-input result", () => {
  const empty = output({
    exit_code: 1,
    stdout: "error TS18003: No inputs were found.",
  });
  const raw = { compilerOptions: { strict: false } };
  expect(effectiveJavascriptConfig(empty, raw, path)).toEqual({
    compilerOptions: raw.compilerOptions,
    files: [],
  });
  for (const result of [
    { ...empty, truncated: true },
    { ...empty, cancelled: true },
    { ...empty, stderr: "failure" },
    output({ exit_code: 9 }),
  ])
    expect(() => effectiveJavascriptConfig(result, raw, path)).toThrow();
});
