import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { changes, type Fingerprints, fingerprint } from "../dependencies/changes";
import { getPackagingStructure } from "../packaging/get-structure";
import { packagingInvocation } from "../packaging/invocation";
import { git, gitContext, gitlinks, gitText, stagedRecords } from "./git";
import { type PrecommitResult } from "./model";
import { type GateOperations, nativeOperations } from "./operations";
import { emptyResult, runGate } from "./pipeline";
import { configConsumers, selectProjects, sharedInputs } from "./selection";
import { EffectLedger } from "./staging";
import { assertWorkspaceBoundary } from "./workspace";

export async function runPrecommit(
  cwd: string,
  signal = new AbortController().signal,
  operations: GateOperations = nativeOperations,
): Promise<PrecommitResult> {
  const result = emptyResult();
  try {
    const context = await gitContext(cwd, signal);
    if (!context) {
      throw new Error("Pre-commit requires a Git working tree");
    }
    const excluded = await gitlinks(context);
    return await packagingInvocation.run({ root: context.root, excluded }, async () => {
      const index = await gitText(context.root, ["ls-files", "--stage", "-z"], signal);
      const records = await stagedRecords(context);
      if (records.some((r) => r.status === "U")) {
        throw new Error("Resolve index conflicts before committing");
      }
      const paths = records
        .flatMap((r) => r.paths)
        .filter((path) => !excluded.some((dir) => path === dir || path.startsWith(`${dir}/`)));
      const { structure } = await getPackagingStructure(context.root, {
        signal,
        publish: false,
      });
      const shared = await sharedInputs(structure);
      if (paths.includes(".justomp/config.json")) {
        const before = await git(context.root, ["show", "HEAD:.justomp/config.json"], signal);
        let after: string;
        try {
          after = await readFile(join(context.root, ".justomp/config.json"), "utf8");
        } catch {
          after = "null";
        }
        shared.set(
          ".justomp/config.json",
          configConsumers(
            structure.projects,
            before.exit_code === 0 && !before.truncated ? before.stdout : null,
            after,
          ),
        );
      }
      const selected = selectProjects(structure.projects, paths, shared);
      result.selected_projects = selected.map((p) => p.project_id);
      const ledger = new EffectLedger(context);
      const metadataPaths = [
        ...new Set([...shared.keys(), ...structure.projects.map((p) => p.manifest), ".justomp/config.json"]),
      ];
      let metadata: Fingerprints = await fingerprint(context.root, metadataPaths);
      const observe = async (paths: string[]) => {
        const next = await fingerprint(context.root, metadataPaths);
        const unexpected = changes(metadata, next).filter((change) => !paths.includes(change.path));
        if (unexpected.length) {
          throw new Error(
            `Unreported metadata change: ${unexpected.map((change) => change.path).join(", ")}; retry commit`,
          );
        }
        metadata = next;
        await ledger.observe(paths);
      };
      if (selected.length) {
        await assertWorkspaceBoundary(context.root, structure, excluded);
        const preparation = await operations.prepare(context.root, signal);
        result.stages.push(preparation);
        result.changed_files = preparation.effects;
        await observe(preparation.effects);
        if (!preparation.complete || !preparation.success) {
          throw new Error("Repository tool preparation incomplete; inspect preparation details");
        }
        const live = (
          await getPackagingStructure(context.root, {
            signal,
            refresh: true,
            publish: false,
          })
        ).structure;
        const topology = (value: typeof structure) =>
          JSON.stringify(
            [value.projects, value.workspaces].map((items) =>
              items.map((item) =>
                "project_id" in item
                  ? [item.project_id, item.path, item.manager, item.managerRoot]
                  : [item.id, item.members],
              ),
            ),
          );
        if (topology(live) !== topology(structure)) {
          throw new Error("Project topology changed during preparation; retry commit");
        }
        const additional = new Set([
          ...preparation.affected_projects,
          ...selectProjects(
            structure.projects,
            preparation.effects.filter((p) => p !== ".justomp/config.json"),
            shared,
          ).map((p) => p.project_id),
        ]);
        for (const project of structure.projects) {
          if (additional.has(project.project_id) && !selected.some((p) => p.project_id === project.project_id)) {
            selected.push(project);
            result.preparation_projects.push(project.project_id);
          }
        }
      }
      const verify = async () => {
        signal.throwIfAborted();
        if (index !== (await gitText(context.root, ["ls-files", "--stage", "-z"], signal))) {
          throw new Error("Git index changed during checks; retry commit");
        }
        await ledger.verify();
        if (changes(metadata, await fingerprint(context.root, metadataPaths)).length) {
          throw new Error("Dependency/config metadata changed between stages; retry commit");
        }
      };
      return runGate(
        selected.map((p) => p.project_id),
        {
          run: (stage, id) => operations.run(stage, context.root, id, signal),
          observe,
          verify,
          stage: async () => {
            try {
              return await ledger.stage();
            } finally {
              result.staged_files = ledger.staged;
            }
          },
          whitespace: async () => {
            const checked = await git(context.root, ["diff", "--cached", "--check", "--"], signal);
            if (checked.cancelled || checked.truncated || checked.exit_code === null) {
              throw new Error("Whitespace check incomplete");
            }
            if (checked.exit_code !== 0) {
              result.errors.push(checked.stdout || checked.stderr);
            }
            return checked.exit_code === 0;
          },
          dependencyKey: (id) => {
            const project = structure.projects.find((p) => p.project_id === id);
            // These adapters issue a root-wide frozen/check command. Go tidy and
            // pnpm's member-relative settings retain separate validation scopes.
            return project && ["uv", "npm", "yarn", "bun"].includes(project.manager ?? "")
              ? `${project.manager}:${project.managerRoot}`
              : id;
          },
        },
        signal,
        result,
      );
    });
  } catch (error) {
    result.cancelled = signal.aborted;
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
}
