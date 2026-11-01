import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { getPackagingStructure } from "../packaging/get-structure";
import { changes, fingerprint, resolutionEvidence } from "./changes";
import {
  resolveExecutable,
  resolveManagerScope,
  validatePnpmNativeScope,
} from "./executable";
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
import {
  type DependencyRequest,
  type Operation,
  parseRequest,
  schemas,
} from "./schemas";
import { validateExistingSources } from "./source-boundaries";
export type AdapterRegistry = Readonly<Record<string, Adapter>>;
function failure(error: unknown) {
  return {
    code: error instanceof DependencyError ? error.code : "dependency-error",
    message: redact(error instanceof Error ? error.message : String(error)),
  };
}
export async function listProjects(
  root: string,
  input: unknown = {},
  signal?: AbortSignal,
) {
  schemas.projects.parse(input);
  const { structure } = await getPackagingStructure(root, { signal });
  return {
    projects: structure.projects.map((p) => ({
      project_id: p.project_id,
      relative_path: p.path,
    })),
  };
}
async function target(
  root: string,
  id: string,
  signal?: AbortSignal,
  refresh = false,
) {
  const { structure } = await getPackagingStructure(root, { signal, refresh });
  const project = structure.projects.find((p) => p.project_id === id);
  if (!project)
    throw new DependencyError(
      "project-not-found",
      "Project ID is no longer present; call list_projects again",
    );
  const workspace = structure.workspaces.find(
    (w) => w.id === project.workspace,
  );
  if (workspace?.status === "unresolved")
    throw new DependencyError(
      "unresolved-workspace",
      "Resolve workspace inspection diagnostics before dependency operations",
    );
  return {
    structure,
    project,
    scope: await resolveManagerScope(
      structure.root,
      project,
      structure.projects,
    ),
  };
}
function verify(
  request: DependencyRequest,
  before: Inventory,
  after: Inventory,
  ecosystem: string,
) {
  if (request.operation === "remove")
    for (const p of request.packages) {
      if (
        after.dependencies.some(
          (d) =>
            (d.direct || d.evidence.field === "require") &&
            d.name === p.name &&
            sameGroup(d.group, request.group),
        )
      )
        throw new DependencyError(
          "postcondition-failed",
          `${p.name} is still declared in the selected group`,
        );
    }
  if (request.operation === "add")
    for (const p of request.packages)
      selectDependency(after, p.name, request.group);
  if (request.operation === "update")
    for (const p of request.packages) {
      const previous = selectDependency(before, p.name, p.group);
      const current = selectDependency(after, p.name, previous.group);
      if (current.source.kind !== previous.source.kind)
        throw new DependencyError(
          "postcondition-failed",
          `${p.name} changed source unexpectedly`,
        );
      if (
        p.version &&
        ecosystem !== "python" &&
        current.declared_specifier.replace(/^v/, "") !==
          p.version.replace(/^v/, "")
      )
        throw new DependencyError(
          "postcondition-failed",
          `${p.name} did not retain the requested exact version`,
        );
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
      const result = await withDomains(domains, signal, async () => {
        const current = await target(root, request.project_id, signal, true);
        if (JSON.stringify(current.scope.domains) !== JSON.stringify(domains))
          return undefined;
        normalizeDependencyRequest(request, current.project.ecosystem);
        const memberManifests = new Set(
          current.structure.projects
            .filter(
              (p) =>
                p.managerRoot === current.project.managerRoot &&
                p.ecosystem === current.project.ecosystem,
            )
            .map((p) => p.manifest),
        );
        if (
          current.structure.diagnostics.some(
            (d) =>
              memberManifests.has(d.path) && d.code === "external-reference",
          )
        ) {
          throw new DependencyError(
            "outside-root",
            "An existing dependency source points outside the inspection root",
          );
        }
        await validateExistingSources(root, current.project, current.structure);
        const executable = await resolveExecutable(
          root,
          current.project,
          signal,
          current.scope,
        );
        if (executable.manager === "pnpm")
          await validatePnpmNativeScope(
            root,
            current.scope,
            executable.command,
            signal,
          );
        const key =
          executable.manager === "yarn"
            ? executable.version.startsWith("1.")
              ? "yarn-classic"
              : "yarn-modern"
            : executable.manager;
        const adapter = adapters[key];
        if (!adapter)
          throw new DependencyError(
            "unsupported-manager",
            `No adapter is registered for ${key}`,
          );
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
        if (request.operation === "list") {
          const inventory = await adapter.inventory(
            context,
            request.include_transitive ?? false,
          );
          signal?.throwIfAborted();
          const visible = redactValues(inventory);
          return {
            outcome: "success",
            project_id: request.project_id,
            manager: { name: key, version: executable.version },
            ...visible,
            dependencies: visible.dependencies.filter(
              (d) => request.include_transitive || d.direct,
            ),
            supported_groups: adapter.groups,
            capabilities: {
              operations: ["list", "add", "remove", "update", "sync"],
              sources: ["registry", "git", "path", "workspace"],
              native_limits: true,
            },
          };
        }
        validateDependencyGroup(request, adapter.groups, key);
        const beforeInventory = await readInventory(root, current.project);
        if (request.operation === "remove")
          for (const p of request.packages)
            selectDependency(beforeInventory, p.name, request.group);
        if (request.operation === "update")
          for (const p of request.packages)
            selectDependency(beforeInventory, p.name, p.group);
        const plan: NativePlan = await adapter.plan(
          context,
          request,
          beforeInventory,
        );
        const metadata = [
          ...new Set([
            ...plan.metadata,
            current.project.manifest,
            ...memberManifests,
          ]),
        ];
        const before = await fingerprint(root, metadata);
        const beforeResolutions = await resolutionEvidence(
          adapter,
          context,
          plan.affectedProjects,
        );
        const native_steps: ({ label: string } & ProcessResult)[] = [];
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
            if (result.cancelled)
              throw new DependencyError(
                "cancelled",
                "Dependency operation was cancelled",
              );
            if (result.exit_code !== 0)
              throw new DependencyError(
                "native-command-failed",
                `Native step failed: ${step.label}`,
              );
          }
          const afterInventory = await adapter.inventory(context, false);
          verify(
            request,
            beforeInventory,
            afterInventory,
            current.project.ecosystem,
          );
          await adapter.verify?.(
            context,
            request,
            beforeInventory,
            afterInventory,
          );
        } catch (e) {
          error = e;
        }
        let metadata_changes: ReturnType<typeof changes> = [];
        const diagnostics: { code: string; message: string }[] = [];
        const checking = request.operation === "sync" && request.check;
        try {
          metadata_changes = changes(before, await fingerprint(root, metadata));
          if (checking) {
            // PnP loaders are install outputs, not dependency input metadata.
            const inputs = metadata_changes.filter(
              ({ path }) =>
                ![".pnp.cjs", ".pnp.loader.mjs"].includes(basename(path)),
            );
            if (inputs.length)
              error ??= new DependencyError(
                "check-input-changed",
                `Check changed dependency input metadata: ${inputs.map(({ path }) => path).join(", ")}`,
              );
          }
        } catch (e) {
          diagnostics.push({
            ...failure(e),
            code: "change-observation-failed",
          });
          if (checking) error ??= e;
        }
        if (error)
          diagnostics.push(
            signal?.aborted
              ? {
                  code: "cancelled",
                  message: "Dependency operation was cancelled",
                }
              : failure(error),
          );
        let structure_refresh_error: ReturnType<typeof failure> | undefined;
        try {
          await getPackagingStructure(root, { refresh: true });
        } catch (e) {
          structure_refresh_error = failure(e);
        }
        const changedPaths = new Set(metadata_changes.map((c) => c.path));
        const afterResolutions = await resolutionEvidence(
          adapter,
          context,
          plan.affectedProjects,
        );
        // Inventory/evidence readers can return incomplete data on cancellation.
        // Check intent still requires a non-success result after the last await.
        if (checking && signal?.aborted && !error) {
          error = new DependencyError(
            "cancelled",
            "Dependency operation was cancelled",
          );
          diagnostics.push(failure(error));
        }
        const affected_projects = current.structure.projects
          .filter((p) => plan.affectedProjects.includes(p.project_id))
          .flatMap((p) => {
            const previous = beforeResolutions.get(p.project_id),
              next = afterResolutions.get(p.project_id);
            const effect = changedPaths.has(p.manifest)
              ? "manifest_changed"
              : previous === undefined || next === undefined
                ? "resolution_scope"
                : previous !== next
                  ? "resolutions_changed"
                  : undefined;
            return effect
              ? [{ project_id: p.project_id, relative_path: p.path, effect }]
              : [];
          });
        const hadEffects =
          metadata_changes.length > 0 ||
          native_steps.some((s) => s.exit_code === 0);
        return {
          outcome: error
            ? hadEffects
              ? "partial_change"
              : signal?.aborted
                ? "cancelled"
                : "failed"
            : "success",
          project_id: request.project_id,
          requested: redactValues(request),
          manager: { name: key, version: executable.version },
          affected_projects,
          metadata_changes,
          native_steps,
          diagnostics,
          ...(structure_refresh_error ? { structure_refresh_error } : {}),
          observation_scope:
            "Dependency metadata only; environment file changes are managed by the native tool",
        };
      });
      if (result !== undefined) return result;
    }
  } catch (error) {
    return {
      outcome: signal?.aborted ? "cancelled" : "rejected",
      project_id: request.project_id,
      diagnostics: [failure(error)],
    };
  }
}
