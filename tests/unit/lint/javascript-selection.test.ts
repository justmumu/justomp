import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { resolveJavascript } from "../../../src/lint/javascript/resolve";
import * as scopes from "../../../src/lint/scope";
import * as versions from "../../../src/lint/versions";
import { scope, target } from "../checks/fixture";

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});
const restores: (() => void)[] = [];
function registry(latest: unknown = "2.6.3") {
  const scan = spyOn(scopes, "collectLintScope").mockResolvedValue(
    scope("index.ts"),
  );
  restores.push(() => scan.mockRestore());
  const fetcher = spyOn(versions, "fetchVersionJSON").mockResolvedValue({
    latest,
  });
  restores.push(() => fetcher.mockRestore());
  return fetcher;
}
const policy = () => resolveLintConfig().policy;
const signal = () => new AbortController().signal;
test("fresh TS and framework projects select only one shared latest Biome", async () => {
  const a = target("javascript"),
    b = target("javascript");
  b.project.project_id = "javascript:packages/web/package.json";
  b.project.frameworks = ["next", "react"];
  const fetcher = registry();
  const selected = await resolveJavascript([a, b], policy(), signal());
  expect(selected).toEqual({
    [a.project.project_id]: { "@biomejs/biome": "2.6.3" },
    [b.project.project_id]: { "@biomejs/biome": "2.6.3" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("%40biomejs%2Fbiome");
});
test("retained Biome wave does not refresh latest or retain obsolete lint tools", async () => {
  const a = target("javascript"),
    fetcher = registry();
  const selected = await resolveJavascript([a], policy(), signal(), {
    [a.project.project_id]: {
      "@biomejs/biome": "2.5.0",
      eslint: "9.0.0",
      typescript: "7.0.2",
      prettier: "3.6.2",
    },
  });
  expect(selected[a.project.project_id]).toEqual({ "@biomejs/biome": "2.5.0" });
  expect(fetcher).not.toHaveBeenCalled();
});
test("new consumer aligns existing Biome consumers to latest", async () => {
  const a = target("javascript"),
    b = target("javascript");
  b.project.project_id = "javascript:new/package.json";
  const fetcher = registry();
  const selected = await resolveJavascript([a, b], policy(), signal(), {
    [a.project.project_id]: { "@biomejs/biome": "2.5.0" },
  });
  expect(Object.values(selected)).toEqual([
    { "@biomejs/biome": "2.6.3" },
    { "@biomejs/biome": "2.6.3" },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test("invalid latest fails without selecting an older release", async () => {
  const fetcher = registry();
  for (const latest of [undefined, "3.0.0-beta.1", "garbage"]) {
    fetcher.mockResolvedValue({ latest });
    await expect(
      resolveJavascript([target("javascript")], policy(), signal()),
    ).rejects.toThrow("exact stable");
  }
});
