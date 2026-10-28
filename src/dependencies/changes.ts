import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { safePath } from "./paths";
export type Fingerprints = Map<string, string | null>;
export async function fingerprint(
  root: string,
  paths: string[],
): Promise<Fingerprints> {
  const result: Fingerprints = new Map();
  for (const path of [...new Set(paths)].sort()) {
    const absolute = await safePath(root, path);
    try {
      result.set(
        relative(root, absolute),
        createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      result.set(relative(root, absolute), null);
    }
  }
  return result;
}
export function changes(before: Fingerprints, after: Fingerprints) {
  return [...after]
    .filter(([path, hash]) => before.get(path) !== hash)
    .map(([path, hash]) => ({
      path,
      change:
        hash === null
          ? "deleted"
          : before.get(path) === null
            ? "created"
            : "modified",
    }));
}

/** Capture resolution evidence without treating a shared lock as proof every member changed. */
export async function resolutionEvidence(
  adapter: import("./model").Adapter,
  context: import("./model").AdapterContext,
  projectIds: string[],
): Promise<Map<string, string | undefined>> {
  const result = new Map<string, string | undefined>();
  for (const project of context.structure.projects.filter((p) =>
    projectIds.includes(p.project_id),
  )) {
    try {
      const cwd = await safePath(context.root, project.path);
      const inventory = await adapter.inventory(
        {
          ...context,
          project,
          cwd,
          run: (step) => context.run({ ...step, cwd: step.cwd ?? cwd }),
        },
        true,
      );
      const entries = inventory.dependencies
        .map((d) => [
          d.name,
          d.group,
          d.source.kind,
          (d.resolutions ?? []).map((r) => r.version).sort(),
        ])
        .map((entry) => JSON.stringify(entry))
        .sort();
      result.set(
        project.project_id,
        inventory.complete
          ? createHash("sha256").update(JSON.stringify(entries)).digest("hex")
          : undefined,
      );
    } catch {
      result.set(project.project_id, undefined);
    }
  }
  return result;
}
