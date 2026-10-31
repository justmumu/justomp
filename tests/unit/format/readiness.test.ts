import { expect, test } from "bun:test";
import { equivalentConfig } from "../../../src/format/readiness";

test("managed structured policies compare values, while semantic drift and malformed data stay stale", async () => {
  for (const [parser, before, expected, changed] of [
    [
      "toml",
      "[tool.ruff]\nline-length=120\n",
      "[tool.ruff]\nline-length = 120\n",
      "[tool.ruff]\nline-length=80\n",
    ],
    [
      "jsonc",
      '// comment\n{"strict":true}',
      '{"strict": true}',
      '{"strict": false}',
    ],
    ["yaml", "version: '2'\n", 'version: "2"\n', "version: '1'\n"],
    [
      "babel",
      'export default {a:"x"};',
      "export default { a: 'x' };\n",
      "export default {a:'y'};",
    ],
  ] as const) {
    expect(await equivalentConfig(before, expected, parser)).toBe(true);
    expect(await equivalentConfig(changed, expected, parser)).toBe(false);
    expect(await equivalentConfig(null, expected, parser)).toBe(false);
  }
  expect(await equivalentConfig("{", "{}", "json")).toBe(false);
});

test("TOML readiness preserves integer and float types", async () => {
  expect(
    await equivalentConfig(
      "line-length = 120.0\n",
      "line-length = 120\n",
      "toml",
    ),
  ).toBe(false);
  expect(
    await equivalentConfig("line-length=120\n", "line-length = 120\n", "toml"),
  ).toBe(true);
  expect(
    await equivalentConfig(
      "value = 9007199254740992\n",
      "value = 9007199254740993\n",
      "toml",
    ),
  ).toBe(false);
});
