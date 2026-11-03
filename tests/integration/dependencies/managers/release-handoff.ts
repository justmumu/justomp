import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AdapterContext } from "../../../../src/dependencies/model";
import { readProjectionFile } from "../../../../src/lint/files";
import { projectJavascriptRelease } from "../../../../src/release/adapters/javascript";
import { releaseLockStep } from "../../../../src/release/adapters/lock-refresh";
import {
  type NativeLockSnapshot,
  readNativeLock,
  resolveReferenceEvidence,
} from "../../../../src/release/native-evidence";
import { classifyParticipant, type ReleaseManifest } from "../../../../src/release/participants";
import {
  type NativeReferenceEvidence,
  planLocalReferences,
  referenceDeclarations,
} from "../../../../src/release/references";

/** Reuses the lifecycle's registry, workspace and runner for one release relock. */
export async function releaseHandoff(context: AdapterContext): Promise<void> {
  const manifests: ReleaseManifest[] = [];
  for (const project of context.structure.projects.filter((project) => project.ecosystem === "javascript")) {
    const snapshot = await readProjectionFile(context.root, join(context.root, project.manifest));
    if (snapshot.text === null) {
      throw new Error("Release fixture manifest missing");
    }
    const data = JSON.parse(snapshot.text) as Record<string, unknown>;
    manifests.push({
      project,
      participant: classifyParticipant(project, data),
      snapshot: { ...snapshot, text: snapshot.text },
      data,
    });
  }
  const scope = {
    manager: context.manager,
    cwd: context.cwd,
    owner: context.owner,
    env: {},
    domains: [],
    pnpm: undefined,
  };
  const before = await readNativeLock(context.root, scope);
  const evidence = manifests.flatMap((manifest) =>
    referenceDeclarations(manifest).map((declaration) =>
      resolveReferenceEvidence(manifest, declaration, manifests, before),
    ),
  );
  const edits = planLocalReferences(manifests, evidence, "1.1.0");
  for (const manifest of manifests) {
    const content = projectJavascriptRelease(
      manifest.snapshot.text,
      manifest.participant.kind === "static" ? "1.1.0" : null,
      edits.filter((edit) => edit.manifest === manifest.project.manifest),
    );
    await writeFile(join(context.root, manifest.project.manifest), content);
    manifest.data = JSON.parse(content) as Record<string, unknown>;
    manifest.participant = classifyParticipant(manifest.project, manifest.data);
  }
  const result = await context.run(releaseLockStep(context.manager, context.version, context.owner));
  expect(result.exit_code, result.stderr).toBe(0);
  expect(result.cancelled).toBe(false);
  const after = await readNativeLock(context.root, scope);
  expect(after.format).toBe(before.format);
  await verifyHandoff(context, manifests, evidence, after);
}
async function verifyHandoff(
  context: AdapterContext,
  manifests: ReleaseManifest[],
  evidence: NativeReferenceEvidence[],
  after: NativeLockSnapshot,
): Promise<void> {
  for (const manifest of manifests) {
    if (manifest.participant.kind === "static") {
      expect(JSON.parse(await readFile(join(context.root, manifest.project.manifest), "utf8")).version).toBe("1.1.0");
    }
    verifyLocalReferences(manifest, manifests, evidence, after);
  }
}
function verifyLocalReferences(
  manifest: ReleaseManifest,
  manifests: ReleaseManifest[],
  evidence: NativeReferenceEvidence[],
  after: NativeLockSnapshot,
): void {
  for (const declaration of referenceDeclarations(manifest)) {
    const original = evidence.find(
      (item) =>
        item.from === manifest.project.project_id && JSON.stringify(item.field) === JSON.stringify(declaration.field),
    );
    if (original?.source !== "local") {
      continue;
    }
    const found = resolveReferenceEvidence(manifest, declaration, manifests, after);
    expect(found.source).toBe("local");
    expect(found.target_project_id).toBe(original.target_project_id);
    if (found.version !== undefined) {
      expect(found.version).toBe("1.1.0");
    }
  }
}
