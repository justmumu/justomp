import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import * as config from "../../../src/config/load";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import type { AdapterContext } from "../../../src/dependencies/model";
import * as paths from "../../../src/dependencies/paths";
import * as files from "../../../src/lint/files";
import * as native from "../../../src/lint/javascript/native";
import * as runtime from "../../../src/lint/runtime";
import { LintStateStore } from "../../../src/lint/state";
import * as packaging from "../../../src/packaging/get-structure";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import type { TypecheckCheckContext } from "../../../src/typecheck/adapters/types";
import * as coordinator from "../../../src/typecheck/coordinator";
import * as freshness from "../../../src/typecheck/freshness";
import * as graph from "../../../src/typecheck/javascript/config-graph";
import * as compiler from "../../../src/typecheck/javascript/native";
import { JavascriptConfigRead } from "../../../src/typecheck/javascript/read-session";
import * as projection from "../../../src/typecheck/projection";
import * as scopes from "../../../src/typecheck/scope";
import {
  type TypecheckState,
  TypecheckStateStore,
} from "../../../src/typecheck/state";
import * as targets from "../../../src/typecheck/targets";
import { output, scope, target } from "../checks/fixture";

/** Supplied storage and native responses; no installs, subprocesses or real files. */
export function generatedUnit(next = true) {
  const restores: (() => void)[] = [];
  function keep<T extends { mockRestore(): void }>(spy: T): T {
    restores.push(() => spy.mockRestore());
    return spy;
  }
  const selected = target("javascript");
  selected.project.manifest = "apps/app/package.json";
  const members = new Map([[selected.project.project_id, selected]]);
  const documents = new Map<string, string>();
  const graphs = new Map<string, graph.JavascriptConfigGraph>();
  const state: TypecheckState = { schema: 1, projects: {}, waves: {} };
  const store = { state, save: async () => {} } as TypecheckStateStore;
  const lint = {
    state: { schema: 2, projects: {}, waves: {} },
    save: async () => {},
  } as unknown as LintStateStore;
  const controller = new AbortController();
  const context: TypecheckCheckContext = {
    target: selected,
    policy: resolveTypecheckConfig().policy,
    versions: { typescript: "7.0.2" },
    signal: controller.signal,
    projection: {
      target: selected,
      files: [],
      configs: { check: [] },
      current: true,
    },
  };
  const fingerprints = { source: "source-v1", inputs: "inputs-v1" };
  const write = (path: string, text: unknown) =>
    documents.set(
      resolve(selected.root, path),
      typeof text === "string" ? text : JSON.stringify(text),
    );
  const register = (
    member: typeof selected,
    manifest: Record<string, unknown> = {},
  ) => {
    members.set(member.project.project_id, member);
    write(member.project.manifest, manifest);
    state.projects[member.project.project_id] = {
      ecosystem: "javascript",
      tools: context.versions,
      ready: true,
      policy_hash: "policy",
    };
    return member;
  };
  register(selected, next ? { dependencies: { next: "16.4.3" } } : {});
  state.waves.javascript = {
    projects: [selected.project.project_id],
    tools: context.versions,
    complete: true,
    pending: [],
  };
  keep(spyOn(TypecheckStateStore, "load").mockResolvedValue(store));
  keep(spyOn(LintStateStore, "load").mockResolvedValue(lint));
  keep(
    spyOn(config, "loadConfig").mockResolvedValue({
      typecheck: context.policy,
    } as Awaited<ReturnType<typeof config.loadConfig>>),
  );
  keep(
    spyOn(paths, "safePath").mockImplementation(async (root, path) =>
      resolve(root, path),
    ),
  );
  keep(
    spyOn(fs, "realpath").mockImplementation((async (path: unknown) =>
      String(path)) as typeof fs.realpath),
  );
  keep(
    spyOn(fs, "readFile").mockImplementation((async (
      path: unknown,
      encoding?: unknown,
    ) => {
      const text = documents.get(String(path));
      if (text === undefined)
        throw Object.assign(new Error("Missing supplied file"), {
          code: "ENOENT",
        });
      return encoding === "utf8" ? text : Buffer.from(text);
    }) as typeof fs.readFile),
  );
  keep(
    spyOn(Bun, "file").mockImplementation(((path: unknown) => ({
      exists: async () => documents.has(String(path)),
    })) as typeof Bun.file),
  );
  keep(
    spyOn(files, "readProjectionFile").mockImplementation(
      async (_root, path) =>
        ({
          text: documents.get(path) ?? null,
          mode: 0o644,
          identity: null,
        }) as Awaited<ReturnType<typeof files.readProjectionFile>>,
    ),
  );
  keep(
    spyOn(projection, "applyProjection").mockImplementation(async (plan) => {
      for (const file of plan.files) write(file.path, file.content);
      return [];
    }),
  );
  keep(
    spyOn(freshness, "snapshotTypecheckFiles").mockImplementation(async () =>
      Object.fromEntries(
        [...documents].map(([path, text]) => [
          relative(selected.root, path),
          freshness.contentHash(text),
        ]),
      ),
    ),
  );
  keep(
    spyOn(freshness, "fingerprintTypecheckAnalysisSources").mockImplementation(
      async () => fingerprints.source,
    ),
  );
  keep(
    spyOn(freshness, "fingerprintTypecheckSources").mockImplementation(
      async () => fingerprints.inputs,
    ),
  );
  keep(
    spyOn(scopes, "collectTypecheckScope").mockImplementation(
      async (member) =>
        graphs.get(member.project.project_id)?.scope ?? {
          ...scope(""),
          files: [],
          empty: true,
        },
    ),
  );
  keep(
    spyOn(targets, "resolveTypecheckTarget").mockImplementation(
      async (_structure, id) => {
        const member = members.get(id);
        if (!member) throw new Error("Unprovided target");
        return member;
      },
    ),
  );
  keep(
    spyOn(packaging, "getPackagingStructure").mockResolvedValue({
      structure: selected.structure,
    } as Awaited<ReturnType<typeof packaging.getPackagingStructure>>),
  );
  keep(
    spyOn(coordinator, "withReadyTypecheckTarget").mockImplementation(
      async (_root, _id, _adapters, operation) => operation(context),
    ),
  );
  keep(
    spyOn(coordinator, "verifyReadyTypecheckContext").mockImplementation(
      async (ctx) => ctx,
    ),
  );
  keep(
    spyOn(JavascriptConfigRead.prototype, "native").mockResolvedValue(
      {} as AdapterContext,
    ),
  );
  keep(
    spyOn(runtime, "lintManagerContext").mockResolvedValue(
      {} as AdapterContext,
    ),
  );
  keep(
    spyOn(graph, "readJavascriptConfigGraph").mockImplementation(
      async (member) =>
        graphs.get(member.project.project_id) ?? {
          nodes: [],
          roots: [],
          scope: { ...scope(""), files: [], empty: true },
        },
    ),
  );
  keep(
    spyOn(JavascriptConfigRead.prototype, "showConfig").mockImplementation(
      async (member, args) => {
        const path = args[args.indexOf("--project") + 1];
        const node = graphs
          .get(member.project.project_id)
          ?.nodes.find((node) => node.path === path);
        if (!node) throw new Error("Unprovided effective config");
        return output({
          stdout: JSON.stringify({
            compilerOptions: node.compilerOptions,
            files: node.files,
          }),
        });
      },
    ),
  );
  const verify = keep(
    spyOn(javascriptAdapter, "verifyTools").mockResolvedValue(true),
  );
  keep(
    spyOn(javascriptAdapter, "plan").mockImplementation(async (member) => ({
      target: member,
      files: [],
      configs: { check: [] },
      current: true,
    })),
  );
  keep(
    spyOn(native, "installedPackages").mockResolvedValue({
      next: { version: "16.4.3", path: "/supplied/next" },
    } as Awaited<ReturnType<typeof native.installedPackages>>),
  );
  const load = keep(
    spyOn(native, "nodeRun").mockImplementation(async (_target, _ctx, args) => {
      if (args[1]?.includes("JUSTOMP_NEXT_INPUTS"))
        return output({
          stdout:
            'JUSTOMP_NEXT_INPUTS={"config":"config/native.json","dist":"generated-next"}',
        });
      const name = args.at(-1);
      const found = [...members.values()].find(
        (member) => member.project.name === name,
      );
      return output({
        stdout: found ? join(found.root, found.project.manifest) : "",
      });
    }),
  );
  const generate = keep(
    spyOn(native, "localTool").mockImplementation(
      async (member, _ctx, tool, args) => {
        if (tool.package !== "next" || args.join(" ") !== "typegen")
          throw new Error("Unexpected native invocation");
        write(
          join(member.scope.cwd, "generated-next/types/validator.ts"),
          "generated",
        );
        write(join(member.scope.cwd, "next-env.d.ts"), "next-env");
        return output();
      },
    ),
  );
  const compile = keep(
    spyOn(compiler, "typescriptRun").mockImplementation(async () => {
      throw new Error("Unprovided compiler response");
    }),
  );
  const add = (
    name: string,
    manifest: Record<string, unknown> = { types: "types/index.d.ts" },
  ) => {
    const member = structuredClone(selected);
    member.project = {
      ...member.project,
      project_id: `javascript:packages/${name}/package.json`,
      path: `packages/${name}`,
      manifest: `packages/${name}/package.json`,
      name,
    };
    member.scope = { ...member.scope, cwd: `/repo/packages/${name}` };
    member.structure = selected.structure;
    selected.structure.projects.push(member.project);
    register(member, manifest);
    const path = join(member.scope.cwd, "tsconfig.json");
    graphs.set(member.project.project_id, {
      roots: [path],
      scope: scope("src/index.ts"),
      nodes: [
        {
          path,
          project_id: member.project.project_id,
          raw: {},
          compilerOptions: {
            composite: true,
            rootDir: "src",
            declarationDir: "types",
          },
          files: [join(member.scope.cwd, "src/index.ts")],
          references: [],
          inherited: [],
        },
      ],
    });
    selected.structure.localDependencies ??= [];
    selected.structure.localDependencies.push({
      from: selected.project.project_id,
      to: member.project.project_id,
      kind: "path",
      evidence: {
        file: selected.project.manifest,
        field: `dependencies.${name}`,
      },
    });
    return member;
  };
  return {
    selected,
    context,
    controller,
    state,
    lint,
    documents,
    graphs,
    members,
    fingerprints,
    load,
    generate,
    compile,
    verify,
    write,
    add,
    register,
    keep,
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}
