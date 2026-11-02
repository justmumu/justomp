import { object } from "../dependencies/inventory";
import { type Ecosystem } from "../inspect/model";
import { TestError, type TestRunner } from "./model";

/** Only declared metadata is inspected; scripts are never executed to discover a runner. */
export function detectRunner(
  ecosystem: Ecosystem,
  manifest: Record<string, unknown>,
  configs: readonly string[],
): TestRunner {
  if (ecosystem === "go") {
    return "go";
  }
  if (ecosystem === "python") {
    const declarations = [
      object(manifest.project).dependencies,
      ...Object.values(object(object(manifest.project)["optional-dependencies"])),
      ...Object.values(object(manifest["dependency-groups"])),
    ].flat();
    if (
      configs.some((f) => /^nose(?:2)?\./.test(f)) ||
      declarations.some((value) => typeof value === "string" && /^nose2?(?:\s|[<>=!~;[]|$)/i.test(value))
    ) {
      throw new TestError("unsupported-runner", "Unsupported Python unit runner; automatic migration is disabled");
    }
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
      (name) => Object.hasOwn(deps, name) || commands.some((c) => new RegExp(`(?:^|[\\s/])${name}(?:\\s|$)`).test(c)),
    ) ||
    configs.some((f) => /^(jest|mocha|ava)\./.test(f)) ||
    commands.some((c) => /\bnode\s+--test\b/.test(c))
  ) {
    throw new TestError("unsupported-runner", "Unsupported existing unit test runner; automatic migration is disabled");
  }
  if (Object.hasOwn(deps, "vitest") || configs.some((f) => /^vitest\.config\./.test(f))) {
    evidence.add("vitest");
  }
  for (const command of commands) {
    if (/(?:^|[\s/])vitest(?:\s|$)/.test(command)) {
      evidence.add("vitest");
    } else if (/\bbun\s+test\b/.test(command)) {
      evidence.add("bun");
    } else if (command && !/^(?:echo [^;&]*[;&]?\s*)?(?:exit 1)?$/.test(command)) {
      throw new TestError("unsupported-runner", `Cannot identify an existing unit test script safely: ${command}`);
    }
  }
  if (evidence.size > 1) {
    throw new TestError("ambiguous-runner", "Conflicting unit test runner evidence");
  }
  if (evidence.size) {
    return [...evidence][0] as TestRunner;
  }
  return Object.hasOwn(object(manifest.engines), "bun") || manifest.runtime === "bun" ? "bun" : "vitest";
}

/** Read literal runner/config evidence without evaluating package scripts. */
export function integrationRunnerEvidence(manifest: Record<string, unknown>, runner: TestRunner): string | undefined {
  const script = object(manifest.scripts)["test:integration"];
  if (script === undefined) {
    return undefined;
  }
  if (typeof script !== "string" || /[;&|`$<>\n\r\\]/.test(script)) {
    throw new TestError("unsupported-runner", "Cannot safely identify test:integration script");
  }
  const tokens: string[] = [];
  const matcher = /\s*((?:"[^"\n]*"|'[^'\n]*'|[^\s"'])+)/gy;
  let position = 0;
  while (position < script.trimEnd().length) {
    matcher.lastIndex = position;
    const match = matcher.exec(script);
    if (!match) {
      throw new TestError("unsupported-runner", "Invalid literal test:integration script");
    }
    tokens.push(
      (match[1] ?? "").replace(
        /"([^"\n]*)"|'([^'\n]*)'/g,
        (_word, double: string | undefined, single: string | undefined) => double ?? single ?? "",
      ),
    );
    position = matcher.lastIndex;
  }
  const command = tokens.shift();
  const identified =
    command === "vitest" ? "vitest" : command === "bun" && tokens.shift() === "test" ? "bun" : undefined;
  if (!identified) {
    throw new TestError(
      "unsupported-runner",
      "Unsupported test:integration runner or wrapper; invoke a supported runner directly",
    );
  }
  if (identified !== runner) {
    throw new TestError("ambiguous-runner", "Conflicting unit and integration runner evidence");
  }
  let config: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token === "--config" || token === "-c") {
      const value = tokens[++i];
      if (!value || value.startsWith("-")) {
        throw new TestError("unsupported-config", "Missing literal integration config path");
      }
      config = value;
    } else if (token.startsWith("--config=") || token.startsWith("-c=")) {
      config = token.slice(token.indexOf("=") + 1);
      if (!config) {
        throw new TestError("unsupported-config", "Missing integration config path");
      }
    } else if (token.startsWith("-")) {
      throw new TestError(
        "unsupported-config",
        `Unsupported integration script option: ${token}; put setup and runtime settings in the selected native config`,
      );
    }
  }
  return config;
}
