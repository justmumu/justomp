import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LintPolicy } from "../../config/lint/model";
import { object } from "../../dependencies/inventory";
import { TypecheckStateStore } from "../../typecheck/state";
import type { ToolVersions } from "../adapters/types";
import type { LintTarget } from "../targets";
import { fetchVersionJSON, stableVersion } from "../versions";
import { nativeJavascriptTools, requiredJavascriptTools } from "./tools";

/** Select exact targets before compatibility preflight; never backtrack to older releases. */
export async function resolveJavascript(
  targets: LintTarget[],
  policy: LintPolicy,
  signal: AbortSignal,
  existing: Record<string, ToolVersions> = {},
): Promise<Record<string, ToolVersions>> {
  const result = Object.fromEntries(
    targets.map((target) => [
      target.project.project_id,
      Object.fromEntries(
        Object.entries(
          nativeJavascriptTools(existing[target.project.project_id] ?? {}),
        ).map(([name, version]) => [name, stableVersion(version)]),
      ),
    ]),
  );
  const required = await Promise.all(
    targets.map((target) => requiredJavascriptTools(target, policy.javascript)),
  );
  if (
    targets.every((target, i) =>
      required[i]?.every((name) => result[target.project.project_id]?.[name]),
    )
  )
    return result;

  const latest = new Map<string, Promise<string>>();
  const resolveLatest = (name: string) => {
    let value = latest.get(name);
    if (!value) {
      value = fetchVersionJSON(
        `https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`,
        signal,
      ).then((data) => stableVersion(object(data).latest));
      latest.set(name, value);
    }
    return value;
  };
  // A newly required tool aligns its existing consumers, without refreshing unrelated pins.
  const missing = new Set(
    targets.flatMap((target, i) =>
      (required[i] ?? []).filter(
        (name) => !result[target.project.project_id]?.[name],
      ),
    ),
  );
  for (const name of missing) {
    const version = await resolveLatest(name);
    for (const [i, target] of targets.entries()) {
      const tools = result[target.project.project_id];
      if (tools && (required[i]?.includes(name) || tools[name]))
        tools[name] = version;
    }
  }

  let compiler: Promise<string> | undefined;
  const fallbackCompiler = (target: LintTarget) => {
    compiler ??= (async () => {
      const state = (await TypecheckStateStore.load(target.root)).state;
      const wave = state.waves.javascript;
      const live = target.structure.projects
        .filter((project) => project.ecosystem === "javascript")
        .map((project) => project.project_id);
      // A prior-membership target must not pin a newly discovered project to an older compiler.
      if (
        wave &&
        wave.pending.length === 0 &&
        wave.projects.length === live.length &&
        live.every((id) => wave.projects.includes(id)) &&
        wave.tools.typescript
      )
        return stableVersion(wave.tools.typescript);
      return resolveLatest("typescript");
    })();
    return compiler;
  };
  for (const [i, target] of targets.entries()) {
    if (!required[i]?.includes("typescript-eslint")) continue;
    const tools = result[target.project.project_id];
    if (!tools || tools.typescript) continue;
    const manifest = object(
      JSON.parse(
        await readFile(join(target.scope.cwd, "package.json"), "utf8"),
      ),
    );
    const declarations = {
      ...object(manifest.dependencies),
      ...object(manifest.devDependencies),
    };
    // Installed-version compatibility belongs to preflight after target persistence.
    if (typeof declarations.typescript !== "string")
      tools.typescript = await fallbackCompiler(target);
  }
  return result;
}
