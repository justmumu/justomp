import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as toml } from "smol-toml";
import { resolveExecutable, validatePnpmNativeScope } from "../../dependencies/executable";
import { object } from "../../dependencies/inventory";
import { type AdapterContext, type NativeStep, type ProcessResult } from "../../dependencies/model";
import { runProcess } from "../../dependencies/runner";
import { normalizePythonName } from "../../inspect/readers/manifest";
import { publishProjectionFile, readProjectionFile } from "../../lint/files";
import { ReleaseError, type ReleaseStep } from "../model";
import { gatherNativeReferenceEvidence, type NativeLockSnapshot, readNativeLock } from "../native-evidence";
import { type ReleaseManifest } from "../participants";
import { type NativeReferenceEvidence, planLocalReferences, type ReferenceEdit } from "../references";
import { inspectReleaseRepository, type ManagerScope, type ReleaseRepository } from "../repository";
import { projectJavascriptRelease } from "./javascript";
import { pythonVersionStep, releaseLockStep } from "./lock-refresh";
import { projectPythonReferences } from "./python";
import { type NativeReleasePlan, type ReleaseOwner } from "./types";

function successful(result: ProcessResult): boolean {
  return result.exit_code === 0 && !result.cancelled && !result.truncated;
}
function assertSame(before: unknown, after: unknown, label: string): void {
  if (!isDeepStrictEqual(before, after)) {
    throw new ReleaseError("metadata-conflict", `Release metadata changed unexpectedly: ${label}`);
  }
}
function projectManifest(manifest: ReleaseManifest, version: string | null, selected: readonly ReferenceEdit[]) {
  const content =
    manifest.project.ecosystem === "javascript"
      ? projectJavascriptRelease(manifest.snapshot.text, version, selected)
      : projectPythonReferences(manifest.snapshot.text, selected);
  const parsed = manifest.project.ecosystem === "javascript" ? object(JSON.parse(content)) : object(toml(content));
  if (manifest.project.ecosystem === "python" && version !== null) {
    object(parsed.project).version = version;
  }
  return { content, parsed };
}
async function prepareOwner(
  repo: ReleaseRepository,
  manifest: ReleaseManifest,
  scope: ManagerScope,
  signal?: AbortSignal,
): Promise<ReleaseOwner> {
  const executable = await resolveExecutable(repo.git.root, manifest.project, signal, scope);
  await validatePnpmNativeScope(repo.git.root, scope, executable.command, signal);
  const context: AdapterContext = {
    root: repo.git.root,
    project: manifest.project,
    structure: repo.structure,
    cwd: scope.cwd,
    owner: scope.owner,
    manager: scope.manager,
    version: executable.version,
    signal,
    run: (step) =>
      runProcess(executable.command, step.args, {
        cwd: step.cwd ?? scope.cwd,
        env: { ...scope.env, ...step.env },
        signal,
      }),
  };
  return {
    context,
    command: executable.command,
    steps: [releaseLockStep(scope.manager, executable.version, scope.owner, scope.pnpm?.lockDirectory)],
    lockBefore: await readNativeLock(repo.git.root, scope, signal),
  };
}
async function ownerForManifest(
  repo: ReleaseRepository,
  manifest: ReleaseManifest,
  owners: Map<string, ReleaseOwner>,
  signal?: AbortSignal,
): Promise<ReleaseOwner> {
  const scope = repo.scopes.get(manifest.project.project_id);
  if (!scope) {
    throw new ReleaseError("unsupported-manager", `Missing release scope for ${manifest.project.manifest}`);
  }
  const key = `${scope.manager}:${scope.owner}:${scope.pnpm?.lockDirectory ?? ""}`;
  let owner = owners.get(key);
  if (!owner) {
    owner = await prepareOwner(repo, manifest, scope, signal);
    owners.set(key, owner);
  }
  return owner;
}
async function prepareManifest(
  repo: ReleaseRepository,
  manifest: ReleaseManifest,
  target: string,
  edits: readonly ReferenceEdit[],
  state: {
    files: NativeReleasePlan["files"];
    expected: NativeReleasePlan["expected"];
    owners: Map<string, ReleaseOwner>;
  },
  signal?: AbortSignal,
): Promise<void> {
  const { files, expected, owners } = state;
  const selected = edits.filter((edit) => edit.manifest === manifest.project.manifest);
  const version = manifest.participant.kind === "static" ? target : null;
  const { content, parsed } = projectManifest(manifest, version, selected);
  expected.set(manifest.project.manifest, parsed);
  if (version === null && !selected.length) {
    return;
  }
  if (content !== manifest.snapshot.text) {
    files.push({ path: manifest.project.manifest, before: manifest.snapshot, content });
  }
  const owner = await ownerForManifest(repo, manifest, owners, signal);
  if (manifest.project.ecosystem === "python" && version !== null) {
    owner.steps.unshift(
      pythonVersionStep(
        target,
        join(repo.git.root, manifest.project.path),
        manifest.project.workspace ? manifest.project.name : undefined,
      ),
    );
  }
}
export async function prepareReleaseAdapters(
  repo: ReleaseRepository,
  target: string,
  evidence: NativeReferenceEvidence[],
  signal?: AbortSignal,
): Promise<NativeReleasePlan> {
  const edits = planLocalReferences(repo.manifests, evidence, target);
  const files: NativeReleasePlan["files"] = [],
    expected: NativeReleasePlan["expected"] = new Map();
  const owners = new Map<string, ReleaseOwner>();
  for (const manifest of repo.manifests) {
    if (manifest.project.ecosystem === "go") {
      continue;
    }
    await prepareManifest(repo, manifest, target, edits, { files, expected, owners }, signal);
  }
  return { repo, target, files, owners: [...owners.values()], references: evidence, expected };
}
export async function applyReleaseMetadata(plan: NativeReleasePlan, signal?: AbortSignal): Promise<void> {
  for (const manifest of plan.repo.manifests) {
    if (manifest.project.ecosystem === "go") {
      continue;
    }
    signal?.throwIfAborted();
    const now = await readProjectionFile(plan.repo.git.root, join(plan.repo.git.root, manifest.project.manifest));
    assertSame(manifest.snapshot, now, manifest.project.manifest);
  }
  for (const file of plan.files) {
    signal?.throwIfAborted();
    await publishProjectionFile(
      plan.repo.git.root,
      join(plan.repo.git.root, file.path),
      file.before,
      file.content,
      () => {
        signal?.throwIfAborted();
        return Promise.resolve();
      },
    );
  }
}
async function verifyPythonBeforeStep(plan: NativeReleasePlan, step: NativeStep): Promise<void> {
  const path = join(step.cwd ?? plan.repo.git.root, "pyproject.toml");
  const manifest = plan.repo.manifests.find(
    (candidate) => join(plan.repo.git.root, candidate.project.manifest) === path,
  );
  if (!manifest) {
    throw new ReleaseError("metadata-conflict", "Python release target disappeared");
  }
  const planned = plan.files.find((candidate) => candidate.path === manifest.project.manifest);
  const now = await readProjectionFile(plan.repo.git.root, path);
  if (now.text !== (planned?.content ?? manifest.snapshot.text)) {
    throw new ReleaseError(
      "metadata-conflict",
      `Python release manifest changed before native update: ${manifest.project.manifest}`,
    );
  }
}
export async function executeReleaseSteps(
  plan: NativeReleasePlan,
  onStep: (step: ReleaseStep) => void,
  signal?: AbortSignal,
): Promise<void> {
  const ordered = plan.owners
    .flatMap((owner) => owner.steps.map((step) => ({ owner, step })))
    .sort((a, b) => Number(a.step.args[0] !== "version") - Number(b.step.args[0] !== "version"));
  for (const { owner, step } of ordered) {
    signal?.throwIfAborted();
    if (step.args[0] === "version") {
      await verifyPythonBeforeStep(plan, step);
    }
    const result = await owner.context.run(step);
    onStep({
      owner: relative(plan.repo.git.root, owner.context.owner) || ".",
      executable: owner.command,
      args: step.args,
      result,
    });
    if (!successful(result)) {
      throw new ReleaseError(
        result.cancelled ? "native-cancelled" : "native-release-failed",
        `${step.label} did not complete: ${result.stderr || result.stdout}`,
      );
    }
  }
}
function ownVersionInLock(manifest: ReleaseManifest, lock: NativeLockSnapshot, target: string): void {
  let version: unknown;
  const key = relative(lock.owner, resolveManifestDirectory(lock.root, manifest)) || "";
  if (lock.format === "npm") {
    version = object(object(lock.document.packages)[key]).version;
  }
  if (lock.format === "bun") {
    version = object(object(lock.document.workspaces)[key]).version;
    if (version === undefined) {
      return;
    }
  }
  if (lock.format === "uv") {
    const packages = Array.isArray(lock.document.package) ? lock.document.package.map(object) : [];
    const match = packages.find(
      (pkg) =>
        typeof pkg.name === "string" &&
        normalizePythonName(pkg.name) === normalizePythonName(manifest.project.name ?? "") &&
        Object.values(object(pkg.source)).includes(key || "."),
    );
    version = match?.version;
  }
  if (["npm", "bun", "uv"].includes(lock.format) && version !== target) {
    throw new ReleaseError(
      "stale-release-lock",
      `Native lock did not record ${manifest.project.manifest} at ${target}`,
    );
  }
}
function resolveManifestDirectory(root: string, manifest: ReleaseManifest): string {
  return join(root, manifest.project.path);
}
function verifyReferences(plan: NativeReleasePlan, evidence: readonly NativeReferenceEvidence[]): void {
  for (const original of plan.references.filter((reference) => reference.source !== "ambiguous")) {
    const found = evidence.find(
      (reference) =>
        reference.from === original.from && JSON.stringify(reference.field) === JSON.stringify(original.field),
    );
    if (
      found?.source !== original.source ||
      (original.source === "local" &&
        (found.target_project_id !== original.target_project_id ||
          (found.version !== undefined && found.version !== plan.target)))
    ) {
      throw new ReleaseError(
        "local-resolution-changed",
        `Native refresh lost local identity/version for ${original.name}`,
      );
    }
  }
}
function verifyLockFormat(before: NativeLockSnapshot, after: NativeLockSnapshot): void {
  if (after.format === "missing") {
    throw new ReleaseError("stale-release-lock", "Native release lock is missing after refresh");
  }
  if (before.format === "binary-bun" && after.format !== "binary-bun") {
    throw new ReleaseError("lock-format-changed", "Bun release refresh unexpectedly migrated binary lock format");
  }
}
export async function verifyReleaseMetadata(plan: NativeReleasePlan, signal?: AbortSignal): Promise<void> {
  const after = await inspectReleaseRepository(plan.repo.git.root, signal);
  assertSame(plan.repo.config.release, after.config.release, "release policy");
  assertSame(plan.repo.scopes, after.scopes, "manager scope");
  assertSame(
    plan.repo.manifests.map((manifest) => manifest.project.project_id),
    after.manifests.map((manifest) => manifest.project.project_id),
    "project scope",
  );
  for (const manifest of after.manifests) {
    if (manifest.project.ecosystem === "go") {
      continue;
    }
    assertSame(plan.expected.get(manifest.project.manifest), manifest.data, manifest.project.manifest);
  }
  const evidence = await gatherNativeReferenceEvidence(after, signal);
  verifyReferences(plan, evidence);
  for (const owner of plan.owners) {
    const scope = after.scopes.get(owner.context.project.project_id);
    if (!scope) {
      throw new ReleaseError("metadata-conflict", "Native release scope disappeared");
    }
    const lock = await readNativeLock(after.git.root, scope, signal);
    verifyLockFormat(owner.lockBefore, lock);
    for (const manifest of after.manifests.filter(
      (candidate) =>
        candidate.participant.kind === "static" &&
        candidate.project.managerRoot === owner.context.project.managerRoot &&
        candidate.project.ecosystem === owner.context.project.ecosystem,
    )) {
      ownVersionInLock(manifest, lock, plan.target);
    }
  }
}
