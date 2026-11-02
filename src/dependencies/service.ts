import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { getPackagingStructure } from "../packaging/get-structure";
import { changes, fingerprint, resolutionEvidence } from "./changes";
import { resolveExecutable, resolveManagerScope, validatePnpmNativeScope } from "./executable";
import { readInventory } from "./inventory";
import {
  type Adapter,
  type AdapterContext,
  DependencyError,
  type Inventory,
  type NativePlan,
  type NativeStep,
  type ProcessResult,
  redact,
  redactValues,
  sameGroup,
  selectDependency,
} from "./model";
import { safePath } from "./paths";
import { withDomains } from "./queue";
import { normalizeDependencyRequest, validateDependencyGroup } from "./request";
import { runProcess } from "./runner";
import { type DependencyRequest, type Operation, parseRequest, schemas } from "./schemas";
import { validateExistingSources } from "./source-boundaries";
export type AdapterRegistry = Readonly<Record<string, Adapter>>;
function failure(error: unknown) {
  return {
    code: error instanceof DependencyError ? error.code : "dependency-error",
    message: redact(error instanceof Error ? error.message : String(error)),
  };
}
export async function listProjects(root: string, input: unknown = {}, signal?: AbortSignal) {
  schemas.projects.parse(input);
  const { structure } = await getPackagingStructure(root, { ...(signal ? { signal } : {}) });
  return {
    projects: structure.projects.map((p) => ({
      project_id: p.project_id,
      relative_path: p.path,
    })),
  };
}
async function target(root: string, id: string, signal?: AbortSignal, refresh = false) {
  const { structure } = await getPackagingStructure(root, { ...(signal ? { signal } : {}), refresh });
  const project = structure.projects.find((p) => p.project_id === id);
  if (!project) {
    throw new DependencyError("project-not-found", "Project ID is no longer present; call list_projects again");
  }
  const workspace = structure.workspaces.find((w) => w.id === project.workspace);
  if (workspace?.status === "unresolved") {
    throw new DependencyError(
      "unresolved-workspace",
      "Resolve workspace inspection diagnostics before dependency operations",
    );
  }
  return {
    structure,
    project,
    scope: await resolveManagerScope(structure.root, project, structure.projects),
  };
}
function verify(request: DependencyRequest, before: Inventory, after: Inventory, ecosystem: string) {
  if (request.operation === "remove") {
    verifyRemoval(request, after);
  }
  if (request.operation === "add") {
    for (const p of request.packages) {
      selectDependency(after, p.name, request.group);
    }
  }
  if (request.operation === "update") {
    for (const p of request.packages) {
      verifyUpdatedDependency(p, before, after, ecosystem);
    }
  }
}
export async function executeDependency(
  root: string,
  operation: Operation,
  input: unknown,
  adapters: AdapterRegistry,
  signal?: AbortSignal,
) {
  let request: DependencyRequest;
  try {
    request = parseRequest(operation, input);
  } catch (error) {
    return { outcome: "rejected", diagnostics: [failure(error)] };
  }
  try {
    root = await realpath(root);
    for (;;) {
      const selected = await target(root, request.project_id, signal);
      const domains = selected.scope.domains;
      const result = await withDomains(domains, signal, () => {
        return executeWithinDomains(root, request, adapters, domains, signal);
      });
      if (result !== undefined) {
        return result;
      }
    }
  } catch (error) {
    return {
      outcome: signal?.aborted ? "cancelled" : "rejected",
      project_id: request.project_id,
      diagnostics: [failure(error)],
    };
  }
}

function verifyUpdatedDependency(
  p: Extract<DependencyRequest, { operation: "update" }>["packages"][number],
  before: Inventory,
  after: Inventory,
  ecosystem: string,
) {
  const previous = selectDependency(before, p.name, p.group);
  const current = selectDependency(after, p.name, previous.group);
  if (current.source.kind !== previous.source.kind) {
    throw new DependencyError("postcondition-failed", `${p.name} changed source unexpectedly`);
  }
  if (
    p.version &&
    ecosystem !== "python" &&
    current.declared_specifier.replace(/^v/, "") !== p.version.replace(/^v/, "")
  ) {
    throw new DependencyError("postcondition-failed", `${p.name} did not retain the requested exact version`);
  }
}

async function executeWithinDomains(
  root: string,
  request: DependencyRequest,
  adapters: AdapterRegistry,
  domains: string[],
  signal?: AbortSignal,
) {
  const current = await target(root, request.project_id, signal, true);
  if (JSON.stringify(current.scope.domains) !== JSON.stringify(domains)) {
    return undefined;
  }
  normalizeDependencyRequest(request, current.project.ecosystem);
  const memberManifests = await validateSelectedSources(root, current);
  const { adapter, context, key } = await selectedAdapter(root, current, adapters, signal);
  if (request.operation === "list") {
    return listDependencies(request, adapter, context, key);
  }
  return mutateDependencies(request, adapter, context, key, memberManifests);
}

async function mutateDependencies(
  request: Exclude<DependencyRequest, { operation: "list" }>,
  adapter: Adapter,
  context: AdapterContext,
  key: string,
  memberManifests: Set<string>,
) {
  const { root, signal } = context;
  validateDependencyGroup(request, adapter.groups, key);
  const beforeInventory = await readInventory(root, context.project);
  validateMutationTargets(request, beforeInventory);
  const plan: NativePlan = await adapter.plan(context, request, beforeInventory);
  const metadata = [...new Set([...plan.metadata, context.project.manifest, ...memberManifests])];
  const before = await fingerprint(root, metadata);
  const beforeResolutions = await resolutionEvidence(adapter, context, plan.affectedProjects);
  const native_steps: ({ label: string } & ProcessResult)[] = [];
  const execution = await executePlan(context, adapter, request, beforeInventory, plan, native_steps);
  let error = execution.error;
  const checking = request.operation === "sync" && request.check;
  const observed = await observeMetadata(root, metadata, before, checking, error);
  const { metadata_changes, diagnostics } = observed;
  error = observed.error;
  if (error) {
    diagnostics.push(
      signal?.aborted
        ? {
            code: "cancelled",
            message: "Dependency operation was cancelled",
          }
        : failure(error),
    );
  }
  let structure_refresh_error: ReturnType<typeof failure> | undefined;
  try {
    await getPackagingStructure(root, { refresh: true });
  } catch (e) {
    structure_refresh_error = failure(e);
  }
  const changedPaths = new Set(metadata_changes.map((c) => c.path));
  const afterResolutions = await resolutionEvidence(adapter, context, plan.affectedProjects);
  // Inventory/evidence readers can return incomplete data on cancellation.
  // Check intent still requires a non-success result after the last await.
  if (checking && signal?.aborted && !error) {
    error = new DependencyError("cancelled", "Dependency operation was cancelled");
    diagnostics.push(failure(error));
  }
  const affected_projects = affectedProjects(context, plan, changedPaths, beforeResolutions, afterResolutions);
  const hadEffects = metadata_changes.length > 0 || native_steps.some((s) => s.exit_code === 0);
  return {
    outcome: mutationOutcome(error, hadEffects, signal),
    project_id: request.project_id,
    requested: redactValues(request),
    manager: { name: key, version: context.version },
    affected_projects,
    metadata_changes,
    native_steps,
    diagnostics,
    ...(structure_refresh_error ? { structure_refresh_error } : {}),
    observation_scope: "Dependency metadata only; environment file changes are managed by the native tool",
  };
}

async function listDependencies(
  request: Extract<DependencyRequest, { operation: "list" }>,
  adapter: Adapter,
  context: AdapterContext,
  key: string,
) {
  const inventory = await adapter.inventory(context, request.include_transitive ?? false);
  context.signal?.throwIfAborted();
  const visible = redactValues(inventory);
  return {
    outcome: "success",
    project_id: request.project_id,
    manager: { name: key, version: context.version },
    ...visible,
    dependencies: visible.dependencies.filter((d) => request.include_transitive || d.direct),
    supported_groups: adapter.groups,
    capabilities: {
      operations: ["list", "add", "remove", "update", "sync"],
      sources: ["registry", "git", "path", "workspace"],
      native_limits: true,
    },
  };
}

async function validateSelectedSources(root: string, current: Awaited<ReturnType<typeof target>>) {
  const memberManifests = new Set(
    current.structure.projects
      .filter((p) => p.managerRoot === current.project.managerRoot && p.ecosystem === current.project.ecosystem)
      .map((p) => p.manifest),
  );
  if (current.structure.diagnostics.some((d) => memberManifests.has(d.path) && d.code === "external-reference")) {
    throw new DependencyError("outside-root", "An existing dependency source points outside the inspection root");
  }
  await validateExistingSources(root, current.project, current.structure);
  return memberManifests;
}

async function selectedAdapter(
  root: string,
  current: Awaited<ReturnType<typeof target>>,
  adapters: AdapterRegistry,
  signal?: AbortSignal,
) {
  const executable = await resolveExecutable(root, current.project, signal, current.scope);
  if (executable.manager === "pnpm") {
    await validatePnpmNativeScope(root, current.scope, executable.command, signal);
  }
  const key =
    executable.manager === "yarn"
      ? executable.version.startsWith("1.")
        ? "yarn-classic"
        : "yarn-modern"
      : executable.manager;
  const adapter = adapters[key];
  if (!adapter) {
    throw new DependencyError("unsupported-manager", `No adapter is registered for ${key}`);
  }
  const context: AdapterContext = {
    root,
    project: current.project,
    structure: current.structure,
    cwd: executable.cwd,
    owner: executable.owner,
    manager: executable.manager,
    version: executable.version,
    signal,
    run: async (step: NativeStep) =>
      runProcess(executable.command, step.args, {
        cwd: await safePath(root, step.cwd ?? executable.cwd),
        env: { ...executable.env, ...step.env },
        signal,
      }),
  };
  return { adapter, context, key };
}

function validateMutationTargets(
  request: Exclude<DependencyRequest, { operation: "list" }>,
  beforeInventory: Inventory,
) {
  if (request.operation === "remove") {
    for (const p of request.packages) {
      selectDependency(beforeInventory, p.name, request.group);
    }
  }
  if (request.operation === "update") {
    for (const p of request.packages) {
      selectDependency(beforeInventory, p.name, p.group);
    }
  }
}

async function executePlan(
  context: AdapterContext,
  adapter: Adapter,
  request: Exclude<DependencyRequest, { operation: "list" }>,
  beforeInventory: Inventory,
  plan: NativePlan,
  native_steps: ({ label: string } & ProcessResult)[],
): Promise<{ error: unknown }> {
  const { signal } = context;
  let error: unknown;
  try {
    for (const step of plan.steps) {
      signal?.throwIfAborted();
      const result = await context.run(step);
      native_steps.push({
        label: step.label,
        ...result,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
      });
      if (result.cancelled) {
        throw new DependencyError("cancelled", "Dependency operation was cancelled");
      }
      if (result.exit_code !== 0) {
        throw new DependencyError("native-command-failed", `Native step failed: ${step.label}`);
      }
    }
    const afterInventory = await adapter.inventory(context, false);
    verify(request, beforeInventory, afterInventory, context.project.ecosystem);
    await adapter.verify?.(context, request, beforeInventory, afterInventory);
  } catch (e) {
    error = e;
  }
  // Keep thrown thenables as failure data instead of assimilating their resolution.
  return { error };
}

async function observeMetadata(
  root: string,
  metadata: string[],
  before: Awaited<ReturnType<typeof fingerprint>>,
  checking: boolean | undefined,
  error: unknown,
) {
  let metadata_changes: ReturnType<typeof changes> = [];
  const diagnostics: { code: string; message: string }[] = [];
  try {
    metadata_changes = changes(before, await fingerprint(root, metadata));
    if (checking) {
      // PnP loaders are install outputs, not dependency input metadata.
      const inputs = metadata_changes.filter(({ path }) => ![".pnp.cjs", ".pnp.loader.mjs"].includes(basename(path)));
      if (inputs.length) {
        error ??= new DependencyError(
          "check-input-changed",
          `Check changed dependency input metadata: ${inputs.map(({ path }) => path).join(", ")}`,
        );
      }
    }
  } catch (e) {
    diagnostics.push({
      ...failure(e),
      code: "change-observation-failed",
    });
    if (checking) {
      error ??= e;
    }
  }
  return { metadata_changes, diagnostics, error };
}

function affectedProjects(
  context: AdapterContext,
  plan: NativePlan,
  changedPaths: Set<string>,
  beforeResolutions: Awaited<ReturnType<typeof resolutionEvidence>>,
  afterResolutions: Awaited<ReturnType<typeof resolutionEvidence>>,
) {
  const affected_projects = context.structure.projects
    .filter((p) => plan.affectedProjects.includes(p.project_id))
    .flatMap((p) => {
      const previous = beforeResolutions.get(p.project_id),
        next = afterResolutions.get(p.project_id);
      const effect = projectEffect(changedPaths.has(p.manifest), previous, next);
      return effect ? [{ project_id: p.project_id, relative_path: p.path, effect }] : [];
    });
  return affected_projects;
}

function verifyRemoval(request: Extract<DependencyRequest, { operation: "remove" }>, after: Inventory) {
  for (const p of request.packages) {
    if (
      after.dependencies.some(
        (d) => (d.direct || d.evidence.field === "require") && d.name === p.name && sameGroup(d.group, request.group),
      )
    ) {
      throw new DependencyError("postcondition-failed", `${p.name} is still declared in the selected group`);
    }
  }
}

function mutationOutcome(error: unknown, hadEffects: boolean, signal?: AbortSignal): string {
  if (!error) {
    return "success";
  }
  if (hadEffects) {
    return "partial_change";
  }
  return signal?.aborted ? "cancelled" : "failed";
}

function projectEffect(manifestChanged: boolean, previous: string | undefined, next: string | undefined) {
  const effect = manifestChanged
    ? "manifest_changed"
    : previous === undefined || next === undefined
      ? "resolution_scope"
      : previous !== next
        ? "resolutions_changed"
        : undefined;
  return effect;
}
