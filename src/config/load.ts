import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { INSPECTION_DEFAULTS } from "./inspection/defaults";
import type { InspectionRules } from "./inspection/model";
import { validateRules } from "./inspection/validate";
import type { LintPolicy } from "./lint/model";
import { lintPolicyKey, resolveLintConfig } from "./lint/resolve";
import type { TestPolicy } from "./test/model";
import { resolveTestConfig, testPolicyKey } from "./test/resolve";
import type { TypecheckPolicy } from "./typecheck/model";
import {
  resolveTypecheckConfig,
  typecheckPolicyKey,
} from "./typecheck/resolve";
export interface LoadedConfig {
  rules: InspectionRules;
  key: string;
  lint: LintPolicy;
  lintKey: string;
  typecheck: TypecheckPolicy;
  typecheckKey: string;
  test: TestPolicy;
  testKey: string;
  wrote: boolean;
}
export class ConfigError extends Error {
  override name = "ConfigError";
}
const startupKey = Symbol.for("justomp.config-startups.v1");
const host = globalThis as typeof globalThis & {
  [startupKey]?: Map<string, Promise<LoadedConfig>>;
};
host[startupKey] ??= new Map<string, Promise<LoadedConfig>>();
const startups = host[startupKey];
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConfigError(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
export async function assertNotSymlink(path: string): Promise<void> {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) throw new ConfigError(`Refusing symlink: ${path}`);
  } catch (error) {
    if (!errno(error, "ENOENT")) throw error;
  }
}
async function read(root: string): Promise<{
  text: string | null;
  object: Record<string, unknown>;
  rules: InspectionRules;
  lint: LintPolicy;
  typecheck: TypecheckPolicy;
  test: TestPolicy;
  missing: boolean;
  identity: string | null;
}> {
  const directory = join(root, ".justomp"),
    path = join(directory, "config.json");
  await assertNotSymlink(directory);
  await assertNotSymlink(path);
  let text: string | null = null,
    identity: string | null = null;
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stats = await file.stat();
      if (!stats.isFile())
        throw new ConfigError("config.json must be a regular file");
      identity = `${stats.dev}:${stats.ino}`;
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!errno(error, "ENOENT")) throw error;
  }
  let object: Record<string, unknown>;
  try {
    object = text === null ? {} : record(JSON.parse(text), "config");
  } catch (error) {
    throw new ConfigError(
      `Invalid config.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw = Object.hasOwn(object, "inspection_rules")
    ? record(object.inspection_rules, "inspection_rules")
    : {};
  const include = Object.hasOwn(raw, "include")
    ? raw.include
    : INSPECTION_DEFAULTS.include;
  const exclude = Object.hasOwn(raw, "exclude")
    ? raw.exclude
    : INSPECTION_DEFAULTS.exclude;
  const rules = { include, exclude };
  validateRules(rules);
  let lint: ReturnType<typeof resolveLintConfig>;
  let typecheck: ReturnType<typeof resolveTypecheckConfig>;
  let test: ReturnType<typeof resolveTestConfig>;
  try {
    test = resolveTestConfig(
      Object.hasOwn(object, "test") ? object.test : undefined,
    );
    lint = resolveLintConfig(
      Object.hasOwn(object, "lint") ? object.lint : undefined,
    );
    typecheck = resolveTypecheckConfig(
      Object.hasOwn(object, "typecheck") ? object.typecheck : undefined,
    );
  } catch (error) {
    throw new ConfigError(
      `Invalid config.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    text,
    object,
    rules,
    lint: lint.policy,
    typecheck: typecheck.policy,
    test: test.policy,
    missing:
      test.missing ||
      lint.missing ||
      typecheck.missing ||
      !Object.hasOwn(raw, "include") ||
      !Object.hasOwn(raw, "exclude"),
    identity,
  };
}
async function execute(
  root: string,
  flush: boolean,
  signal?: AbortSignal,
): Promise<LoadedConfig> {
  signal?.throwIfAborted();
  const initial = await read(root);
  signal?.throwIfAborted();
  const result = {
    rules: initial.rules,
    key: JSON.stringify(initial.rules),
    lint: initial.lint,
    lintKey: lintPolicyKey(initial.lint),
    typecheck: initial.typecheck,
    typecheckKey: typecheckPolicyKey(initial.typecheck),
    test: initial.test,
    testKey: testPolicyKey(initial.test),
    wrote: false,
  };
  if (!flush || !initial.missing) return result;
  const directory = join(root, ".justomp"),
    path = join(directory, "config.json");
  await mkdir(directory, { recursive: true });
  await assertNotSymlink(directory);
  const raw = initial.object.inspection_rules ?? {};
  const object = {
    ...initial.object,
    lint: initial.lint,
    typecheck: initial.typecheck,
    test: initial.test,
    inspection_rules: { ...(raw as Record<string, unknown>), ...initial.rules },
  };
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(object, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    const current = await read(root);
    signal?.throwIfAborted();
    if (current.text !== initial.text || current.identity !== initial.identity)
      throw new ConfigError(
        "config-conflict: configuration changed during startup; retry startup",
      );
    await assertNotSymlink(directory);
    await assertNotSymlink(path);
    signal?.throwIfAborted();
    if (initial.text === null) {
      try {
        await link(temporary, path);
      } catch (error) {
        if (errno(error, "EEXIST"))
          throw new ConfigError(
            "config-conflict: configuration created during startup; retry startup",
          );
        throw error;
      }
    } else await rename(temporary, path);
    return { ...result, wrote: true };
  } finally {
    await unlink(temporary).catch((error) => {
      if (!errno(error, "ENOENT")) throw error;
    });
  }
}
export async function loadConfig(
  root: string,
  options: { flush?: boolean; signal?: AbortSignal } = {},
): Promise<LoadedConfig> {
  if (!options.flush) return execute(root, false, options.signal);
  const previous = startups.get(root);
  const task = (async () => {
    if (previous) await previous.catch(() => undefined);
    return execute(root, true, options.signal);
  })();
  startups.set(root, task);
  try {
    return await task;
  } finally {
    if (startups.get(root) === task) startups.delete(root);
  }
}
