import { afterEach, expect, test } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
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
import { INSPECTION_DEFAULTS } from "../../src/config/inspection/defaults";
import { resolveIntegrationTestConfig } from "../../src/config/integration-test/resolve";
import { resolveLintConfig } from "../../src/config/lint/resolve";
import { loadConfig } from "../../src/config/load";
import { resolveTestConfig } from "../../src/config/test/resolve";
import { resolveTypecheckConfig } from "../../src/config/typecheck/resolve";

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
    lint: resolveLintConfig().policy,
    typecheck: resolveTypecheckConfig().policy,
    test: resolveTestConfig().policy,
    integration_test: resolveIntegrationTestConfig().policy,
    inspection_rules: { exclude: [], custom: true, include: ["**/*"] },
  });
  const stamp = (await stat(join(root, ".justomp/config.json"))).mtimeMs;
  expect((await loadConfig(root, { flush: true })).wrote).toBe(false);
  expect((await stat(join(root, ".justomp/config.json"))).mtimeMs).toBe(stamp);
});
test("missing file, partial defaults and concurrent startup preserve values", async () => {
  const root = await fixture();
  expect((await loadConfig(root)).rules).toEqual(INSPECTION_DEFAULTS);
  expect(await Bun.file(join(root, ".justomp/config.json")).exists()).toBe(
    false,
  );
  await Promise.all(
    Array.from({ length: 8 }, () => loadConfig(root, { flush: true })),
  );
  expect(
    JSON.parse(await readFile(join(root, ".justomp/config.json"), "utf8"))
      .inspection_rules,
  ).toEqual(INSPECTION_DEFAULTS);
  await writeFile(
    join(root, ".justomp/config.json"),
    JSON.stringify({ inspection_rules: { include: [] } }),
  );
  expect((await loadConfig(root, { flush: true })).rules).toEqual({
    include: [],
    exclude: INSPECTION_DEFAULTS.exclude,
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

test("lint defaults flush without changing inspection policy and hashes stay independent", async () => {
  const root = await fixture({
    inspection_rules: { include: [], exclude: ["custom"] },
    extra: { keep: true },
    lint: { python: { ruff: { lint: { ignore: [] } } } },
  });
  const path = join(root, ".justomp/config.json");
  const initial = await loadConfig(root, { flush: true });
  expect(initial.lint.python.ruff.lint.ignore).toEqual([]);
  expect(initial.lint.python.ruff["line-length"]).toBe(120);
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.extra).toEqual({ keep: true });
  expect(saved.inspection_rules).toEqual({ include: [], exclude: ["custom"] });
  saved.lint.python.ruff["line-length"] = 100;
  await writeFile(path, JSON.stringify(saved));
  const changed = await loadConfig(root);
  expect(changed.key).toBe(initial.key);
  expect(changed.lintKey).not.toBe(initial.lintKey);
  saved.inspection_rules.include = ["src/**"];
  await writeFile(path, JSON.stringify(saved));
  const discoveryChange = await loadConfig(root);
  expect(discoveryChange.key).not.toBe(changed.key);
  expect(discoveryChange.lintKey).toBe(changed.lintKey);
});

test("invalid lint values are never replaced or flushed", async () => {
  const root = await fixture({
    lint: { python: { ruff: { lint: { ignore: null } } } },
  });
  const path = join(root, ".justomp/config.json");
  const before = await readFile(path, "utf8");
  await expect(loadConfig(root, { flush: true })).rejects.toThrow(
    "lint.python.ruff.lint.ignore",
  );
  expect(await readFile(path, "utf8")).toBe(before);
});

test.each(["content", "identity"])(
  "concurrent %s changes are preserved instead of publishing stale lint defaults",
  async (change) => {
    const root = await fixture({ extra: "original" });
    const path = join(root, ".justomp/config.json");
    const before = await readFile(path, "utf8");
    const replacement =
      change === "content" ? JSON.stringify({ extra: "concurrent" }) : before;
    const controller = new AbortController();
    const originalCheck = controller.signal.throwIfAborted.bind(
      controller.signal,
    );
    let checks = 0;
    // Inject an external write after the initial read and before publishing defaults.
    controller.signal.throwIfAborted = () => {
      originalCheck();
      if (++checks === 2) {
        if (change === "content") writeFileSync(path, replacement);
        else {
          writeFileSync(`${path}.replacement`, replacement);
          renameSync(`${path}.replacement`, path);
        }
      }
    };
    await expect(
      loadConfig(root, { flush: true, signal: controller.signal }),
    ).rejects.toThrow("config-conflict");
    expect(await readFile(path, "utf8")).toBe(replacement);
  },
);

test("typecheck defaults flush once while preserving independent policies and user overrides", async () => {
  const root = await fixture({
    inspection_rules: { include: [], exclude: ["custom"] },
    lint: { python: { ruff: { lint: { ignore: [] } } } },
    typecheck: {
      python: { pyright: { diagnostics: {} } },
      javascript: { compilerOptions: { checkJs: false } },
      go: { build_tags: [] },
      future: true,
    },
  });
  const path = join(root, ".justomp/config.json");
  const initial = await loadConfig(root, { flush: true });
  expect(initial.typecheck.python.pyright.diagnostics).toEqual({});
  expect(initial.typecheck.javascript.compilerOptions.checkJs).toBe(false);
  expect(initial.typecheck.javascript.compilerOptions.strict).toBe(true);
  expect(initial.typecheck.go.build_tags).toEqual([]);
  expect(initial.typecheck.future).toBe(true);
  const bytes = await readFile(path, "utf8");
  const second = await loadConfig(root, { flush: true });
  expect(second.wrote).toBe(false);
  expect(await readFile(path, "utf8")).toBe(bytes);
  const saved = JSON.parse(bytes);
  expect(saved.typecheck).toEqual(initial.typecheck);
  saved.typecheck.javascript.compilerOptions.checkJs = true;
  await writeFile(path, JSON.stringify(saved));
  const changed = await loadConfig(root);
  expect(changed.typecheckKey).not.toBe(initial.typecheckKey);
  expect(changed.lintKey).toBe(initial.lintKey);
  expect(changed.key).toBe(initial.key);
});

test("invalid typecheck values are not rewritten by config flush", async () => {
  const root = await fixture({ typecheck: { go: { build_tags: null } } });
  const path = join(root, ".justomp/config.json");
  const before = await readFile(path, "utf8");
  await expect(loadConfig(root, { flush: true })).rejects.toThrow(
    "typecheck.go.build_tags",
  );
  expect(await readFile(path, "utf8")).toBe(before);
});

test("test policy flush preserves false and zero without changing other policy hashes", async () => {
  const root = await fixture({
    test: { python: { coverage: { enabled: false, minimum: 0 } } },
  });
  const before = await loadConfig(root, { flush: true });
  expect(before.test.python.coverage).toEqual({ enabled: false, minimum: 0 });
  const path = join(root, ".justomp/config.json");
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.test.python.coverage.minimum = 80;
  await writeFile(path, JSON.stringify(raw));
  const after = await loadConfig(root);
  expect(after.testKey).not.toBe(before.testKey);
  expect(after.key).toBe(before.key);
  expect(after.lintKey).toBe(before.lintKey);
  expect(after.typecheckKey).toBe(before.typecheckKey);
});

test("integration policy flush preserves explicit leaves and has independent keys", async () => {
  const root = await fixture({
    integration_test: {
      python: { include: [], coverage: { enabled: false, minimum: 0 } },
    },
  });
  const before = await loadConfig(root, { flush: true });
  expect(before.integrationTest.python.include).toEqual([]);
  const path = join(root, ".justomp/config.json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.integration_test.python.coverage).toEqual({
    enabled: false,
    minimum: 0,
  });
  saved.integration_test.go.coverage.minimum = 20;
  await writeFile(path, JSON.stringify(saved));
  const after = await loadConfig(root);
  expect(after.integrationTestKey).not.toBe(before.integrationTestKey);
  expect(after.testingKey).not.toBe(before.testingKey);
  for (const key of ["key", "testKey", "lintKey", "typecheckKey"] as const)
    expect(after[key]).toBe(before[key]);
});
