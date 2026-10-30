import { object } from "../dependencies/inventory";
import type { Ecosystem } from "../inspect/model";
import { TestError, type TestRunner } from "./model";

/** Only declared metadata is inspected; scripts are never executed to discover a runner. */
export function detectRunner(
  ecosystem: Ecosystem,
  manifest: Record<string, unknown>,
  configs: readonly string[],
): TestRunner {
  if (ecosystem === "go") return "go";
  if (ecosystem === "python") {
    const declarations = [
      object(manifest.project).dependencies,
      ...Object.values(
        object(object(manifest.project)["optional-dependencies"]),
      ),
      ...Object.values(object(manifest["dependency-groups"])),
    ].flat();
    if (
      configs.some((f) => /^nose(?:2)?\./.test(f)) ||
      declarations.some(
        (value) =>
          typeof value === "string" && /^nose2?(?:\s|[<>=!~;[]|$)/i.test(value),
      )
    )
      throw new TestError(
        "unsupported-runner",
        "Unsupported Python unit runner; automatic migration is disabled",
      );
    return "pytest";
  }
  const deps = {
    ...object(manifest.dependencies),
    ...object(manifest.devDependencies),
  };
  const evidence = new Set<TestRunner>();
  const scripts = object(manifest.scripts);
  const commands = Object.entries(scripts)
    .filter(([k]) => k === "test" || k === "test:unit")
    .map(([, v]) => (typeof v === "string" ? v : ""));
  const unsupported = ["jest", "mocha", "ava", "jasmine", "tap", "tape", "uvu"];
  if (
    unsupported.some(
      (name) =>
        Object.hasOwn(deps, name) ||
        commands.some((c) =>
          new RegExp(`(?:^|[\\s/])${name}(?:\\s|$)`).test(c),
        ),
    ) ||
    configs.some((f) => /^(jest|mocha|ava)\./.test(f)) ||
    commands.some((c) => /\bnode\s+--test\b/.test(c))
  )
    throw new TestError(
      "unsupported-runner",
      "Unsupported existing unit test runner; automatic migration is disabled",
    );
  if (
    Object.hasOwn(deps, "vitest") ||
    configs.some((f) => /^vitest\.config\./.test(f))
  )
    evidence.add("vitest");
  for (const command of commands) {
    if (/(?:^|[\s/])vitest(?:\s|$)/.test(command)) evidence.add("vitest");
    else if (/\bbun\s+test\b/.test(command)) evidence.add("bun");
    else if (command && !/^(?:echo [^;&]*[;&]?\s*)?(?:exit 1)?$/.test(command))
      throw new TestError(
        "unsupported-runner",
        `Cannot identify an existing unit test script safely: ${command}`,
      );
  }
  if (evidence.size > 1)
    throw new TestError(
      "ambiguous-runner",
      "Conflicting unit test runner evidence",
    );
  if (evidence.size) return [...evidence][0] as TestRunner;
  return Object.hasOwn(object(manifest.engines), "bun") ||
    manifest.runtime === "bun"
    ? "bun"
    : "vitest";
}
