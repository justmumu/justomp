import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES } from "../../src/config/defaults";
import { loadConfig } from "../../src/config/load";

const roots: string[] = [];
async function fixture(config?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "justomp-config-"));
  roots.push(root);
  if (config !== undefined) {
    await mkdir(join(root, ".justomp"));
    await writeFile(join(root, ".justomp/config.json"), JSON.stringify(config));
  }
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
test("read does not flush, startup fills only absent attributes and is idempotent", async () => {
  const root = await fixture({
    extra: 4,
    inspection_rules: { exclude: [], custom: true },
  });
  const before = await readFile(join(root, ".justomp/config.json"), "utf8");
  expect((await loadConfig(root)).rules).toEqual({
    include: ["**/*"],
    exclude: [],
  });
  expect(await readFile(join(root, ".justomp/config.json"), "utf8")).toBe(
    before,
  );
  expect((await loadConfig(root, { flush: true })).wrote).toBe(true);
  expect(
    JSON.parse(await readFile(join(root, ".justomp/config.json"), "utf8")),
  ).toEqual({
    extra: 4,
    inspection_rules: { exclude: [], custom: true, include: ["**/*"] },
  });
  const stamp = (await stat(join(root, ".justomp/config.json"))).mtimeMs;
  expect((await loadConfig(root, { flush: true })).wrote).toBe(false);
  expect((await stat(join(root, ".justomp/config.json"))).mtimeMs).toBe(stamp);
});
test("missing file, partial defaults and concurrent startup preserve values", async () => {
  const root = await fixture();
  expect((await loadConfig(root)).rules).toEqual(DEFAULT_RULES);
  expect(await Bun.file(join(root, ".justomp/config.json")).exists()).toBe(
    false,
  );
  await Promise.all(
    Array.from({ length: 8 }, () => loadConfig(root, { flush: true })),
  );
  expect(
    JSON.parse(await readFile(join(root, ".justomp/config.json"), "utf8"))
      .inspection_rules,
  ).toEqual(DEFAULT_RULES);
  await writeFile(
    join(root, ".justomp/config.json"),
    JSON.stringify({ inspection_rules: { include: [] } }),
  );
  expect((await loadConfig(root, { flush: true })).rules).toEqual({
    include: [],
    exclude: DEFAULT_RULES.exclude,
  });
});
test("invalid config and symlink targets are never rewritten", async () => {
  const root = await fixture({ inspection_rules: { exclude: null } });
  const p = join(root, ".justomp/config.json");
  const before = await readFile(p, "utf8");
  await expect(loadConfig(root, { flush: true })).rejects.toThrow();
  expect(await readFile(p, "utf8")).toBe(before);
  await rm(p);
  const target = join(root, "user.json");
  await writeFile(target, "{}");
  await symlink(target, p);
  await expect(loadConfig(root, { flush: true })).rejects.toThrow("symlink");
  expect(await readFile(target, "utf8")).toBe("{}");
});
