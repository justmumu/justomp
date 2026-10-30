import type { LintPolicy } from "../../config/lint/model";
import type { ToolVersions } from "../adapters/types";
import { LintError } from "../model";
import { lintManagerContext } from "../runtime";
import type { LintTarget } from "../targets";
import { stableVersion } from "../versions";
import {
  applicationVersions,
  compatible,
  type Metadata,
  nodeVersion,
  registryPackage,
  satisfies,
  toolMetadata,
  validateCompatibility,
} from "./compatibility";
import { requiredJavascriptTools } from "./tools";

export async function resolveJavascript(
  targets: LintTarget[],
  policy: LintPolicy,
  signal: AbortSignal,
  existing: Record<string, ToolVersions> = {},
): Promise<Record<string, ToolVersions>> {
  const required = await Promise.all(
    targets.map((target) => requiredJavascriptTools(target, policy.javascript)),
  );
  if (
    targets.every((target, index) =>
      required[index]?.every(
        (name) => existing[target.project.project_id]?.[name],
      ),
    )
  ) {
    return Object.fromEntries(
      targets.map((target) => [
        target.project.project_id,
        Object.fromEntries(
          Object.entries(existing[target.project.project_id] ?? {}).map(
            ([name, version]) => [name, stableVersion(version)],
          ),
        ),
      ]),
    );
  }
  const registry = new Map<string, Metadata[]>();
  const releases = async (name: string) => {
    let values = registry.get(name);
    if (!values) {
      values = await registryPackage(name, signal);
      registry.set(name, values);
    }
    return values;
  };
  const shared: ToolVersions = {};
  for (const tools of Object.values(existing))
    for (const [name, version] of Object.entries(tools))
      if (name !== "@next/eslint-plugin-next" && name !== "typescript") {
        if (shared[name] && shared[name] !== version)
          throw new LintError(
            "incompatible-toolchain",
            `Retained core tool ${name} has inconsistent versions`,
          );
        shared[name] = stableVersion(version);
      }
  const facts = await Promise.all(
    targets.map(async (target) => {
      const native = await lintManagerContext(target, signal);
      return {
        target,
        native,
        node: await nodeVersion(target, native, signal),
        app: await applicationVersions(target, native, signal),
      };
    }),
  );
  for (const [index, fact] of facts.entries()) {
    if (
      required[index]?.includes("typescript-eslint") &&
      fact.app.typescript &&
      !shared["typescript-eslint"]
    ) {
      if (
        !(await releases("typescript-eslint")).some(
          (data) =>
            satisfies(
              fact.app.typescript ?? "",
              (data.peerDependencies as Record<string, unknown> | undefined)
                ?.typescript,
            ) && compatible(data, fact.app, fact.node),
        )
      )
        throw new LintError(
          "incompatible-toolchain",
          `No stable typescript-eslint supports application TypeScript ${fact.app.typescript}; reconcile TypeScript explicitly`,
        );
    }
  }
  const eslintVersions = shared.eslint
    ? [shared.eslint]
    : (await releases("eslint"))
        .filter((value) => Number(String(value.version).split(".")[0]) >= 9)
        .map((value) => stableVersion(value.version));
  for (const eslint of eslintVersions) {
    const cohort: ToolVersions = { ...shared, eslint };
    const result: Record<string, ToolVersions> = {};
    let valid = true;
    for (const [index, fact] of facts.entries()) {
      const names = [
        ...new Set([
          ...(required[index] ?? []),
          ...Object.keys(existing[fact.target.project.project_id] ?? {}),
        ]),
      ];
      if (names.includes("typescript-eslint") && !fact.app.typescript)
        names.push("typescript");
      // Choose application TypeScript before testing parser peer compatibility.
      names.sort((a, b) =>
        a === "typescript" ? -1 : b === "typescript" ? 1 : 0,
      );
      const selected = {
        ...cohort,
        ...existing[fact.target.project.project_id],
      };
      const metadata: Record<string, Metadata> = {};
      for (const name of names) {
        let data: Metadata | undefined;
        if (selected[name])
          data = (
            await toolMetadata(
              fact.target,
              fact.native,
              { [name]: selected[name] },
              signal,
            )
          )[name];
        else if (name === "typescript") {
          const parser = selected["typescript-eslint"]
            ? (
                await toolMetadata(
                  fact.target,
                  fact.native,
                  { "typescript-eslint": selected["typescript-eslint"] },
                  signal,
                )
              )["typescript-eslint"]
            : (await releases("typescript-eslint")).find((value) =>
                compatible(value, selected, fact.node),
              );
          const range = (
            parser?.peerDependencies as Record<string, unknown> | undefined
          )?.typescript;
          data = (await releases(name)).find(
            (value) =>
              satisfies(stableVersion(value.version), range) &&
              compatible(value, selected, fact.node),
          );
        } else
          data = (await releases(name)).find((value) => {
            const version = stableVersion(value.version);
            if (
              name === "@eslint/js" &&
              version.split(".")[0] !== eslint.split(".")[0]
            )
              return false;
            if (
              name === "@next/eslint-plugin-next" &&
              version.split(".")[0] !== fact.app.next?.split(".")[0]
            )
              return false;
            return compatible(value, { ...selected, ...fact.app }, fact.node);
          });
        if (!data) {
          valid = false;
          break;
        }
        selected[name] = stableVersion(data.version);
        metadata[name] = data;
      }
      if (!valid) break;
      try {
        validateCompatibility(metadata, selected, fact.app, fact.node);
      } catch {
        valid = false;
        break;
      }
      for (const name of names)
        if (name !== "@next/eslint-plugin-next" && name !== "typescript")
          cohort[name] = selected[name] ?? "";
      result[fact.target.project.project_id] = Object.fromEntries(
        names.map((name) => [name, selected[name] ?? ""]),
      );
    }
    if (valid) return result;
  }
  throw new LintError(
    "incompatible-toolchain",
    "No compatible stable JavaScript tool cohort for the installed Node, TypeScript, Next and retained tool versions; typed rules remain enabled",
  );
}
