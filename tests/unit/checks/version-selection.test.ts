import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { goLintAdapter } from "../../../src/lint/adapters/go";
import { pythonAdapter } from "../../../src/lint/adapters/python";
import * as versions from "../../../src/lint/versions";
import { target } from "./fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
});
function metadata(value: unknown) {
  const query = spyOn(versions, "fetchVersionJSON").mockResolvedValue(value);
  restores.push(() => query.mockRestore());
  return query;
}
test("PyPI selects one stable non-yanked Ruff for the wave, retains pins and propagates query failure", async () => {
  const first = target("python"),
    second = structuredClone(first);
  second.project.project_id = "python:other";
  const query = metadata({
    info: { version: "0.18.0rc1" },
    releases: {
      "0.17.3": [{ yanked: false }],
      "0.17.2": [{ yanked: false }],
      "0.18.0rc1": [{ yanked: false }],
      "0.18.0": [{ yanked: true }],
    },
  });
  const policy = resolveLintConfig().policy,
    signal = new AbortController().signal;
  const pins = await pythonAdapter.resolve([first, second], policy, signal);
  expect(Object.values(pins)).toEqual([{ ruff: "0.17.3" }, { ruff: "0.17.3" }]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(await pythonAdapter.resolve([first, second], policy, signal, pins)).toEqual(pins);
  expect(query).toHaveBeenCalledTimes(1);
  query.mockRejectedValue(new Error("registry unavailable"));
  await expect(pythonAdapter.resolve([first], policy, signal)).rejects.toThrow("registry unavailable");
});
test("official Go release selection retains exact pins without another registry call", async () => {
  const selected = target("go"),
    query = metadata({ tag_name: "v2.15.0", prerelease: false });
  const policy = resolveLintConfig().policy,
    signal = new AbortController().signal;
  const pins = await goLintAdapter.resolve([selected], policy, signal);
  expect(pins).toEqual({
    [selected.project.project_id]: { "golangci-lint": "2.15.0" },
  });
  expect(await goLintAdapter.resolve([selected], policy, signal, pins)).toEqual(pins);
  expect(query).toHaveBeenCalledTimes(1);
  query.mockResolvedValue({ tag_name: "v2.16.0-beta.1", prerelease: true });
  await expect(goLintAdapter.resolve([selected], policy, signal)).rejects.toThrow("not stable");
});
