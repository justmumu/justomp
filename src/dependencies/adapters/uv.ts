import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as toml } from "smol-toml";
import { normalizePythonName } from "../../inspect/readers/manifest";
import { object, readInventory } from "../inventory";
import {
  type Adapter,
  type AdapterContext,
  type Dependency,
  DependencyError,
  type Group,
  type Inventory,
  type NativeStep,
  sameGroup,
  selectDependency,
} from "../model";
import { localSource } from "../paths";

function groupArgs(group: Group): string[] {
  switch (group.kind) {
    case "runtime":
      return [];
    case "dev":
      return ["--dev"];
    case "named":
      if (normalizePythonName(group.name) === "dev")
        throw new DependencyError(
          "unsupported-group",
          "Use the dev group selector for uv's reserved dev group",
        );
      return ["--group", group.name];
    case "extra":
      return ["--optional", group.name];
    default:
      throw new DependencyError(
        "unsupported-group",
        `uv has no native ${group.kind} group`,
      );
  }
}
function releaseKey(version: string): string {
  const match = /^v?(\d+(?:\.\d+)*)(.*)$/i.exec(version);
  if (!match?.[1]) return version;
  const release = match[1].split(".").map(Number);
  while (release.length > 1 && release.at(-1) === 0) release.pop();
  return `${release.join(".")}${(match[2] ?? "").toLowerCase()}`;
}
function requirement(
  name: string,
  version: string,
  previous?: Dependency,
): string {
  return `${name}${previous?.extras?.length ? `[${previous.extras.join(",")}]` : ""}${version}${previous?.marker ? `; ${previous.marker}` : ""}`;
}
function step(
  context: AdapterContext,
  args: string[],
  label: string,
): NativeStep {
  return {
    args,
    cwd: context.cwd,
    env: { UV_PYTHON_DOWNLOADS: "never", UV_WORKING_DIR: context.cwd },
    label,
  };
}
function syncArgs(context: AdapterContext): string[] {
  return [
    "sync",
    ...(context.project.workspace && context.project.name
      ? ["--package", context.project.name]
      : []),
  ];
}
async function nativeSource(context: AdapterContext, name: string) {
  let result = {
    value: {} as Record<string, unknown>,
    directory: context.owner,
  };
  for (const manifest of new Set([
    join(context.owner, "pyproject.toml"),
    join(context.root, context.project.manifest),
  ])) {
    const data = object(toml(await readFile(manifest, "utf8")));
    const sources = object(object(object(data.tool).uv).sources);
    const key = Object.keys(sources).find(
      (key) => normalizePythonName(key) === name,
    );
    if (key)
      result = { value: object(sources[key]), directory: dirname(manifest) };
  }
  return result;
}
function incomplete(inventory: Inventory): Inventory {
  return {
    ...inventory,
    complete: false,
    diagnostics: [
      ...inventory.diagnostics,
      {
        code: "resolution-unavailable",
        message:
          "A complete supported uv.lock graph for this project is unavailable",
      },
    ],
  };
}
interface LockedPackage {
  name: string;
  version: string;
  source: Record<string, unknown>;
  dependencies?: unknown;
  "optional-dependencies"?: unknown;
  "dev-dependencies"?: unknown;
}
function refs(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((r) => typeof object(r).name !== "string")
  )
    throw new Error("Invalid uv lock edge");
  return value.map(object);
}
function sourceKind(source: Record<string, unknown>): Dependency["source"] {
  return {
    kind: source.registry
      ? "registry"
      : source.git
        ? "git"
        : source.editable || source.directory
          ? "path"
          : "unknown",
  };
}

export const uvAdapter: Adapter = {
  groups: ["runtime", "dev", "named", "extra"],
  async plan(context, request, inventory) {
    const members = context.structure.projects.filter(
      (p) =>
        p.ecosystem === "python" &&
        p.managerRoot === context.project.managerRoot,
    );
    const plan = {
      steps: [] as NativeStep[],
      metadata: [
        ...new Set([
          join(context.project.managerRoot, "uv.lock"),
          join(context.project.managerRoot, "pyproject.toml"),
          ...members.map((p) => p.manifest),
        ]),
      ],
      affectedProjects: members.map((p) => p.project_id),
    };
    if (request.operation === "sync") {
      try {
        await readFile(join(context.owner, "uv.lock"));
      } catch {
        throw new DependencyError(
          "missing-lock",
          "uv sync requires an existing uv.lock",
        );
      }
      plan.steps.push(
        step(
          context,
          [...syncArgs(context), "--locked"],
          "Sync locked Python environment",
        ),
      );
      return plan;
    }
    if (request.operation === "add") {
      const group = groupArgs(request.group);
      for (const p of request.packages) {
        const name = normalizePythonName(p.name);
        const existing = inventory.dependencies.filter(
          (d) =>
            d.direct && d.name === name && sameGroup(d.group, request.group),
        );
        const previous = existing.length
          ? selectDependency(inventory, name, request.group)
          : undefined;
        // uv sources are shared by declarations of the same package across groups.
        const siblings = inventory.dependencies.filter(
          (d) =>
            d.direct && d.name === name && !sameGroup(d.group, request.group),
        );
        const path =
          p.source.kind === "path" || p.source.kind === "workspace"
            ? await localSource(context, p.source)
            : undefined;
        if (siblings.length) {
          const current = await nativeSource(context, name);
          const matchingSource =
            p.source.kind === "registry"
              ? siblings.every((d) => d.source.kind === "registry")
              : p.source.kind === "path"
                ? typeof current.value.path === "string" &&
                  resolve(current.directory, current.value.path) === path
                : p.source.kind === "workspace"
                  ? current.value.workspace === true
                  : current.value.git === p.source.url.replace(/^git\+/, "") &&
                    [
                      current.value.rev,
                      current.value.branch,
                      current.value.tag,
                    ].includes(p.source.ref);
          if (
            !matchingSource ||
            siblings.some((d) => d.ambiguous || d.source.kind !== p.source.kind)
          )
            throw new DependencyError(
              "unsupported-source-operation",
              "Changing a shared uv source would affect another group",
            );
        }
        let spec: string;
        const flags: string[] = [];
        if (p.source.kind === "registry") {
          const configured = await nativeSource(context, name);
          if (
            (configured.value.path ||
              configured.value.git ||
              configured.value.workspace ||
              configured.value.url) &&
            (!previous ||
              configured.directory !==
                dirname(join(context.root, context.project.manifest)))
          )
            throw new DependencyError(
              "unsupported-source-operation",
              "An inherited or undeclared uv source overrides this registry addition; resolve that source explicitly first",
            );
          spec = requirement(name, p.version ?? "", previous);
          if (previous && previous.source.kind !== "registry")
            plan.steps.push(
              step(
                context,
                ["remove", ...group, name],
                `Remove previous source for ${name}`,
              ),
            );
        } else if (p.source.kind === "git") {
          const url = p.source.url.startsWith("git+")
            ? p.source.url
            : `git+${p.source.url}`;
          spec = requirement(name, ` @ ${url}`, previous);
          flags.push("--rev", p.source.ref);
        } else {
          if (!path)
            throw new DependencyError(
              "source-not-found",
              "Local source path is unavailable",
            );
          if (p.source.kind === "workspace") {
            const target = context.structure.projects.find(
              (p) => resolve(context.root, p.path) === path,
            );
            if (!target?.name || normalizePythonName(target.name) !== name)
              throw new DependencyError(
                "source-not-found",
                "Workspace source name must match the selected project",
              );
            spec = requirement(name, "", previous);
            flags.push("--workspace");
          } else {
            spec = requirement(
              name,
              ` @ ${pathToFileURL(path).href}`,
              previous,
            );
            flags.push("--no-workspace");
          }
        }
        plan.steps.push(
          step(
            context,
            ["add", ...group, ...flags, spec],
            `Add ${name} to ${request.group.kind}`,
          ),
        );
      }
    } else if (request.operation === "remove") {
      const group = groupArgs(request.group);
      for (const p of request.packages)
        selectDependency(inventory, normalizePythonName(p.name), request.group);
      plan.steps.push(
        step(
          context,
          [
            "remove",
            ...group,
            ...request.packages.map((p) => normalizePythonName(p.name)),
          ],
          `Remove selected ${request.group.kind} dependencies`,
        ),
      );
    } else {
      const selected = new Set<string>();
      for (const p of request.packages) {
        const name = normalizePythonName(p.name),
          previous = selectDependency(inventory, name, p.group);
        const key = `${name}:${JSON.stringify(previous.group)}`;
        if (selected.has(key))
          throw new DependencyError(
            "ambiguous-dependency",
            "Duplicate dependency occurrence",
          );
        selected.add(key);
        groupArgs(previous.group);
        if (previous.source.kind !== "registry") {
          if (p.version || previous.source.kind !== "git")
            throw new DependencyError(
              "unsupported-source-operation",
              "This source has no native release update; use explicit add to change its source",
            );
          const { value: source } = await nativeSource(context, name);
          if (
            !source.branch &&
            !source.rev &&
            previous.declared_specifier.includes("@")
          )
            throw new DependencyError(
              "unsupported-source-operation",
              "Only a declared Git ref can be refreshed",
            );
          if (
            source.tag ||
            (typeof source.rev === "string" &&
              /^[0-9a-f]{7,40}$/i.test(source.rev))
          )
            throw new DependencyError(
              "unsupported-source-operation",
              "An immutable Git source cannot be upgraded",
            );
        }
        if (
          p.version ||
          (request.mode === "latest" && previous.source.kind === "registry")
        ) {
          const spec = requirement(
            name,
            p.version ? `==${p.version}` : ">=0",
            previous,
          );
          plan.steps.push(
            step(
              context,
              [
                "add",
                ...groupArgs(previous.group),
                "--upgrade-package",
                name,
                spec,
              ],
              `Update ${name} declaration`,
            ),
          );
        } else {
          const active =
            previous.group.kind === "extra"
              ? ["--extra", previous.group.name]
              : previous.group.kind === "named"
                ? ["--group", previous.group.name]
                : previous.group.kind === "dev"
                  ? ["--group", "dev"]
                  : [];
          plan.steps.push(
            step(
              context,
              [...syncArgs(context), ...active, "--upgrade-package", name],
              `Upgrade ${name} within its constraints`,
            ),
          );
        }
      }
    }
    return plan;
  },
  async inventory(context, transitive) {
    const inventory = await readInventory(context.root, context.project);
    try {
      const data = object(
        toml(await readFile(join(context.owner, "uv.lock"), "utf8")),
      );
      if (
        data.version !== 1 ||
        typeof data.revision !== "number" ||
        data.revision > 3 ||
        !Array.isArray(data.package)
      )
        return incomplete(inventory);
      const packages = data.package.map((value) => {
        const p = object(value);
        if (
          typeof p.name !== "string" ||
          typeof p.version !== "string" ||
          Object.keys(object(p.source)).length !== 1
        )
          throw new Error("Invalid uv lock package");
        return p as unknown as LockedPackage;
      });
      const root = packages.find(
        (p) =>
          normalizePythonName(p.name) ===
            normalizePythonName(context.project.name ?? "") &&
          [p.source.virtual, p.source.editable, p.source.directory].some(
            (path) =>
              typeof path === "string" &&
              resolve(context.owner, path) ===
                resolve(context.root, context.project.path),
          ),
      );
      if (!root) return incomplete(inventory);
      const queue: { ref: Record<string, unknown>; group: Group }[] = [];
      for (const ref of refs(root.dependencies))
        queue.push({ ref, group: { kind: "runtime" } });
      for (const [name, values] of Object.entries(
        object(root["dev-dependencies"]),
      ))
        for (const ref of refs(values))
          queue.push({
            ref,
            group: name === "dev" ? { kind: "dev" } : { kind: "named", name },
          });
      for (const [name, values] of Object.entries(
        object(root["optional-dependencies"]),
      ))
        for (const ref of refs(values))
          queue.push({ ref, group: { kind: "extra", name } });
      const packagesByName = new Map<
        string,
        { package: LockedPackage; index: number }[]
      >();
      packages.forEach((p, index) => {
        const candidates = packagesByName.get(p.name) ?? [];
        candidates.push({ package: p, index });
        packagesByName.set(p.name, candidates);
      });
      const recordKey = (name: string, group: Group) =>
        JSON.stringify([name, group.kind, "name" in group ? group.name : null]);
      const recordsByGroup = new Map<string, Dependency[]>();
      for (const record of inventory.dependencies) {
        const key = recordKey(record.name, record.group);
        const records = recordsByGroup.get(key) ?? [];
        records.push(record);
        recordsByGroup.set(key, records);
      }
      const visited = new Set<string>();
      for (let index = 0; index < queue.length; index++) {
        const item = queue[index];
        if (!item) continue;
        const candidates = (
          packagesByName.get(String(item.ref.name)) ?? []
        ).filter(
          ({ package: p }) =>
            (!item.ref.version || item.ref.version === p.version) &&
            (!item.ref.source ||
              JSON.stringify(item.ref.source) === JSON.stringify(p.source)),
        );
        if (!candidates.length) throw new Error("Unresolved uv lock reference");
        for (const { package: p, index: packageIndex } of candidates) {
          const name = normalizePythonName(p.name);
          const groupKey = recordKey(name, item.group);
          let records = recordsByGroup.get(groupKey) ?? [];
          if (!records.length && transitive) {
            const record: Dependency = {
              name,
              group: item.group,
              declared_specifier: "",
              source: sourceKind(p.source),
              direct: false,
              evidence: {
                file: join(context.project.managerRoot, "uv.lock"),
                field: "package",
              },
            };
            inventory.dependencies.push(record);
            records = [record];
            recordsByGroup.set(groupKey, records);
          }
          for (const record of records) {
            record.resolutions ??= [];
            if (!record.resolutions.some((r) => r.version === p.version))
              record.resolutions.push({
                version: p.version,
                evidence: join(context.project.managerRoot, "uv.lock"),
              });
          }
          const extra = item.ref.extra;
          if (
            extra !== undefined &&
            (!Array.isArray(extra) || extra.some((e) => typeof e !== "string"))
          )
            throw new Error("Invalid uv extra edge");
          const key = `${packageIndex}:${JSON.stringify(item.group)}:${JSON.stringify(extra ?? [])}`;
          if (visited.has(key)) continue;
          visited.add(key);
          for (const ref of refs(p.dependencies))
            queue.push({ ref, group: item.group });
          if (Array.isArray(extra))
            for (const e of extra)
              for (const ref of refs(
                object(p["optional-dependencies"])[String(e)],
              ))
                queue.push({ ref, group: item.group });
        }
      }
      if (
        inventory.dependencies.some((d) => d.direct && !d.resolutions?.length)
      )
        return incomplete(inventory);
      return inventory;
    } catch {
      return incomplete(inventory);
    }
  },
  async verify(_context, request, before, after) {
    if (request.operation === "add") {
      for (const p of request.packages) {
        const current = selectDependency(
          after,
          normalizePythonName(p.name),
          request.group,
        );
        if (current.source.kind !== p.source.kind)
          throw new DependencyError(
            "postcondition-failed",
            "uv did not retain the requested source kind",
          );
      }
    }
    if (request.operation !== "update") return;
    for (const p of request.packages) {
      const previous = selectDependency(
        before,
        normalizePythonName(p.name),
        p.group,
      );
      const current = selectDependency(after, previous.name, previous.group);
      if (
        Boolean(current.marker) !== Boolean(previous.marker) ||
        JSON.stringify(current.extras ?? []) !==
          JSON.stringify(previous.extras ?? []) ||
        current.source.kind !== previous.source.kind
      )
        throw new DependencyError(
          "postcondition-failed",
          "uv changed dependency source, extras or marker",
        );
      if (
        p.version &&
        (!current.declared_specifier.startsWith("==") ||
          releaseKey(current.declared_specifier.slice(2)) !==
            releaseKey(p.version) ||
          !current.resolutions?.length ||
          current.resolutions.some(
            (r) => releaseKey(r.version) !== releaseKey(p.version ?? ""),
          ))
      )
        throw new DependencyError(
          "postcondition-failed",
          `uv did not select exact version ${p.version}`,
        );
    }
  },
};
