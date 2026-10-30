import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readOptional } from "../../dependencies/executable";
import { object } from "../../dependencies/inventory";
import type { DependencyRequest } from "../../dependencies/model";
import { redact } from "../../dependencies/model";
import { within } from "../../dependencies/paths";
import {
  compatible,
  nodeVersion,
  toolMetadata,
} from "../../lint/javascript/compatibility";
import {
  installedPackages,
  nativeAdapter,
  succeeded,
} from "../../lint/javascript/native";
import { lintManagerContext } from "../../lint/runtime";
import {
  assertTypecheckNative,
  typecheckNative,
  typescriptRun,
} from "../javascript/native";
import {
  type TypecheckCheck,
  type TypecheckDiagnostic,
  TypecheckError,
} from "../model";
import { planJavascriptProjection } from "../projections/javascript";
import { collectTypecheckScope } from "../scope";
import { fetchVersionJSON, stableVersion } from "../versions";
import type {
  TypecheckAdapter,
  TypecheckCheckContext,
  TypecheckOperationContext,
} from "./types";

async function operations(context: TypecheckOperationContext) {
  let common: string | undefined;
  const operations = [];
  for (const target of context.targets) {
    const version = stableVersion(
      context.versions[target.project.project_id]?.typescript,
    );
    if (common && common !== version)
      throw new TypecheckError(
        "invalid-version",
        "TypeScript batch requires one common exact version",
      );
    common = version;
    const native = await lintManagerContext(target, context.signal),
      adapter = nativeAdapter(native);
    const before = await adapter.inventory(native, false);
    const declarations = before.dependencies.filter(
      (item) => item.name === "typescript",
    );
    if (
      declarations.length > 1 ||
      declarations.some(
        (item) => item.group.kind !== "dev" || item.source.kind !== "registry",
      )
    )
      throw new TypecheckError(
        "conflicting-declaration",
        "TypeScript must have one registry dev declaration; reconcile existing sources/groups explicitly",
      );
    const manifest = object(
      JSON.parse(
        (await readOptional(join(native.owner, "package.json"))) ?? "{}",
      ),
    );
    const pnpm = object(
      parseYaml(
        (await readOptional(join(native.owner, "pnpm-workspace.yaml"))) ?? "{}",
      ),
    );
    const overrides = [
      manifest.overrides,
      manifest.resolutions,
      object(manifest.pnpm).overrides,
      pnpm.overrides,
    ];
    const inspect = (value: unknown): void => {
      for (const [key, entry] of Object.entries(object(value))) {
        if (
          /(^|[/ >])typescript(?:@|$)/.test(key) &&
          typeof entry === "string" &&
          entry !== version
        )
          throw new TypecheckError(
            "incompatible-toolchain",
            `Native override ${key}=${entry} conflicts with TypeScript ${version}; reconcile it explicitly`,
          );
        inspect(entry);
      }
    };
    for (const override of overrides) inspect(override);
    const request: Exclude<DependencyRequest, { operation: "list" }> =
      declarations.length
        ? {
            operation: "update",
            project_id: target.project.project_id,
            mode: "within_constraints",
            packages: [{ name: "typescript", version, group: { kind: "dev" } }],
          }
        : {
            operation: "add",
            project_id: target.project.project_id,
            group: { kind: "dev" },
            packages: [
              { name: "typescript", version, source: { kind: "registry" } },
            ],
          };
    const plan = await adapter.plan(native, request, before);
    if (request.operation === "add")
      for (const step of plan.steps)
        step.args.push(
          native.manager === "npm" || native.manager === "pnpm"
            ? "--save-exact"
            : "--exact",
        );
    operations.push({ target, native, adapter, request, plan });
  }
  return operations;
}
/** Parse the compiler's non-pretty protocol without treating crashes or clipped output as diagnostics. */
export function typescriptDiagnostics(
  context: TypecheckCheckContext,
  output: string,
): TypecheckDiagnostic[] {
  const diagnostics: TypecheckDiagnostic[] = [];
  const owners = context.target.structure.projects
    .filter((project) => project.ecosystem === "javascript")
    .sort((a, b) => b.path.length - a.path.length)
    .map((project) => ({
      project,
      root: resolve(context.target.root, project.path),
    }));
  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    if (!line.trim()) continue;
    const located = /^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    const global = /^error TS(\d+): (.*)$/.exec(line);
    if (located || global) {
      const filename = located?.[1];
      const absolute = filename
        ? resolve(context.target.scope.cwd, filename)
        : undefined;
      const origin = absolute
        ? owners.find((owner) => within(owner.root, absolute))
        : undefined;
      diagnostics.push({
        project_id:
          origin?.project.project_id ?? context.target.project.project_id,
        severity: "error",
        rule: `TS${located?.[4] ?? global?.[1]}`,
        message: redact(located?.[5] ?? global?.[2] ?? ""),
        ...(absolute
          ? {
              path: relative(context.target.root, absolute).replaceAll(
                "\\",
                "/",
              ),
              project_path: relative(
                origin?.root ?? context.target.scope.cwd,
                absolute,
              ).replaceAll("\\", "/"),
              line: Number(located?.[2]),
              column: Number(located?.[3]),
            }
          : {}),
      });
    } else if (/^\s+\S/.test(line) && diagnostics.length) {
      const previous = diagnostics.at(-1);
      if (previous) previous.message += `\n${redact(line)}`;
    } else
      throw new TypecheckError(
        "invalid-diagnostics",
        `Unrecognized TypeScript output: ${redact(line)}`,
      );
  }
  return diagnostics;
}
export const javascriptAdapter: TypecheckAdapter = {
  async resolve(targets, _policy, signal) {
    const data = object(
      await fetchVersionJSON(
        "https://registry.npmjs.org/-/package/typescript/dist-tags",
        signal,
      ),
    );
    const version = stableVersion(data.latest);
    return Object.fromEntries(
      targets.map((target) => [
        target.project.project_id,
        { typescript: version },
      ]),
    );
  },
  async preflight(context) {
    return typecheckNative(async () => {
      for (const { target, native } of await operations(context)) {
        const tools = context.versions[target.project.project_id] ?? {};
        const metadata = await toolMetadata(
          target,
          native,
          tools,
          context.signal,
        );
        const node = await nodeVersion(target, native, context.signal);
        if (
          !metadata.typescript ||
          !compatible(metadata.typescript, tools, node)
        )
          throw new TypecheckError(
            "incompatible-toolchain",
            `TypeScript ${tools.typescript} is incompatible with installed Node ${node}`,
          );
      }
    });
  },
  async prepareBatch(context) {
    return typecheckNative(async () => {
      const all = await operations(context);
      const metadata = new Map<string, string>();
      for (const { target, plan } of all)
        for (const path of plan.metadata)
          metadata.set(join(target.root, path), target.project.project_id);
      const before = new Map<string, string | null>();
      for (const path of metadata.keys())
        before.set(path, (await readOptional(path)) ?? null);
      try {
        for (const { native, adapter, request, plan } of all) {
          const previous = await adapter.inventory(native, false);
          for (const step of plan.steps)
            assertTypecheckNative(await native.run(step), step.label);
          await adapter.verify?.(
            native,
            request,
            previous,
            await adapter.inventory(native, false),
          );
        }
      } finally {
        for (const [path, project_id] of metadata) {
          const after = (await readOptional(path)) ?? null;
          if (after !== before.get(path))
            context.changes.push({
              project_id,
              path: relative(context.targets[0]?.root ?? "", path).replaceAll(
                "\\",
                "/",
              ),
              kind:
                after === null
                  ? "removed"
                  : before.get(path) === null
                    ? "created"
                    : "updated",
            });
        }
      }
    });
  },
  async verifyTools(context) {
    try {
      const { target, signal, versions } = context;
      const native = await lintManagerContext(target, signal),
        inventory = await nativeAdapter(native).inventory(native, false);
      if (!inventory.complete || inventory.diagnostics.length) return false;
      const items = inventory.dependencies.filter(
          (item) => item.name === "typescript",
        ),
        item = items[0];
      if (
        items.length !== 1 ||
        !item ||
        item.group.kind !== "dev" ||
        item.source.kind !== "registry" ||
        item.declared_specifier !== versions.typescript ||
        !item.resolutions?.length ||
        item.resolutions.some((value) => value.version !== versions.typescript)
      )
        return false;
      const metadata = (
        await installedPackages(target, native, ["typescript"], signal)
      ).typescript;
      if (
        !metadata ||
        metadata.version !== versions.typescript ||
        !compatible(
          metadata,
          versions,
          await nodeVersion(target, native, signal),
        )
      )
        return false;
      const result = await typescriptRun(target, ["--version"], signal, native);
      return (
        succeeded(result) &&
        result.stdout.trim() === `Version ${versions.typescript}`
      );
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  plan: planJavascriptProjection,
  async check(context) {
    const scope = await collectTypecheckScope(context.target);
    const check: TypecheckCheck = {
      status: scope.empty ? "no-sources" : "not-run",
      tool: "typescript",
      version: context.versions.typescript ?? null,
      exit_code: null,
      duration_ms: 0,
      diagnostics: [],
      truncated: false,
      cancelled: false,
    };
    if (scope.empty) return [check];
    const start = performance.now();
    try {
      if (
        !(await this.plan(context.target, context.policy, context.signal))
          .current
      )
        throw new TypecheckError(
          "outdated-projection",
          "TypeScript policy projection needs preparation",
        );
      if (!context.projection.configs.check.length)
        throw new TypecheckError(
          "missing-config",
          "Missing TypeScript check configuration",
        );
      for (const path of context.projection.configs.check) {
        const result = await typescriptRun(
          context.target,
          [
            "--project",
            path,
            "--pretty",
            "false",
            "--noEmit",
            "--incremental",
            "false",
          ],
          context.signal,
        );
        check.exit_code =
          result.exit_code === null
            ? null
            : Math.max(check.exit_code ?? 0, result.exit_code);
        check.truncated ||= result.truncated;
        check.cancelled ||= result.cancelled;
        if (
          result.truncated ||
          result.cancelled ||
          ![0, 1, 2].includes(result.exit_code ?? -1) ||
          result.stderr.trim()
        )
          throw new TypecheckError(
            "native-check-failed",
            redact(
              result.stderr ||
                result.stdout ||
                `TypeScript did not complete (exit ${result.exit_code})`,
            ),
          );
        const diagnostics = typescriptDiagnostics(context, result.stdout);
        if (result.exit_code !== 0 && !diagnostics.length)
          throw new TypecheckError(
            "invalid-diagnostics",
            `TypeScript exited ${result.exit_code} without diagnostics`,
          );
        check.diagnostics.push(...diagnostics);
      }
      check.status = check.diagnostics.length ? "failed" : "passed";
    } catch (error) {
      check.status = "not-run";
      check.reason = redact(
        error instanceof Error ? error.message : String(error),
      );
      check.cancelled ||= context.signal.aborted;
    } finally {
      check.duration_ms = performance.now() - start;
    }
    return [check];
  },
};
