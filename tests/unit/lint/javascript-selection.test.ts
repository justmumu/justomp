import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { resolveJavascript } from "../../../src/lint/javascript/resolve";
import { BIOME_VERSION } from "../../../src/lint/toolchain";
import * as versions from "../../../src/lint/versions";
import { target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
});

test("fresh framework and existing projects select the bundled Biome pin without registry discovery", async () => {
  const a = target("javascript"),
    b = target("javascript");
  b.project.project_id = "javascript:packages/web/package.json";
  b.project.frameworks = ["next", "react"];
  const fetcher = spyOn(versions, "fetchVersionJSON").mockRejectedValue(new Error("No registry access"));
  restores.push(() => fetcher.mockRestore());
  const selected = await resolveJavascript([a, b], resolveLintConfig().policy, new AbortController().signal, {
    [a.project.project_id]: {
      "@biomejs/biome": "2.5.0",
      eslint: "9.0.0",
      typescript: "7.0.2",
      prettier: "3.6.2",
    },
  });
  expect(selected).toEqual({
    [a.project.project_id]: { "@biomejs/biome": BIOME_VERSION },
    [b.project.project_id]: { "@biomejs/biome": BIOME_VERSION },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test("a persisted invalid or newer Biome selection cannot replace the bundled pin", async () => {
  const selected = target("javascript");
  for (const version of ["garbage", "3.0.0-beta.1", "99.0.0", BIOME_VERSION]) {
    expect(
      await resolveJavascript([selected], resolveLintConfig().policy, new AbortController().signal, {
        [selected.project.project_id]: { "@biomejs/biome": version },
      }),
    ).toEqual({ [selected.project.project_id]: { "@biomejs/biome": BIOME_VERSION } });
  }
});

test("empty selection has no consumers and cancelled selection does not publish tools", async () => {
  const controller = new AbortController();
  expect(await resolveJavascript([], resolveLintConfig().policy, controller.signal)).toEqual({});
  controller.abort();
  await expect(
    resolveJavascript([target("javascript")], resolveLintConfig().policy, controller.signal),
  ).rejects.toThrow();
});
