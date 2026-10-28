import { join, posix, relative } from "node:path";
import { parseDocument } from "yaml";
import { pnpmDirectories, readOptional } from "../executable";
import { object, readInventory, sourceOf } from "../inventory";
import {
  type Adapter,
  type AdapterContext,
  type Dependency,
  DependencyError,
  type Inventory,
  type NativeStep,
  selectDependency,
} from "../model";
import {
  addResolution,
  declarationField,
  groupFlag,
  jsGroups,
  jsPlan,
  jsSource,
  rejectOtherGroups,
  unavailable,
  verifyJs,
} from "./js-common";

function step(ctx: AdapterContext, label: string, args: string[]): NativeStep {
  return {
    label,
    args: [
      ...args,
      ...(ctx.project.workspace && ctx.cwd === ctx.owner
        ? ["--workspace-root"]
        : []),
    ],
    cwd: ctx.cwd,
  };
}
async function inventory(
  ctx: AdapterContext,
  transitive: boolean,
): Promise<Inventory> {
  const { lockDirectory } = await pnpmDirectories(ctx.cwd, ctx.owner);
  const result = await readInventory(ctx.root, ctx.project),
    file = relative(ctx.root, join(lockDirectory, "pnpm-lock.yaml")),
    text = await readOptional(join(ctx.root, file));
  if (!text)
    return unavailable(
      result,
      transitive,
      "pnpm lock is missing; direct declarations remain available",
    );
  try {
    const doc = parseDocument(text);
    if (doc.errors.length) throw new Error("Invalid pnpm lock YAML");
    const lock = object(doc.toJS());
    if (String(lock.lockfileVersion) !== "9.0")
      throw new Error("Unsupported pnpm lock schema");
    const importers = object(lock.importers),
      key = relative(lockDirectory, ctx.cwd).split("\\").join("/") || ".",
      importer = object(importers[key]),
      snapshots = object(lock.snapshots),
      packages = object(lock.packages);
    const seen = new Set<string>();
    const visit = (
      name: string,
      reference: string,
      from: string,
      direct?: Dependency,
    ) => {
      if (reference.startsWith("link:")) {
        const target = posix.normalize(posix.join(from, reference.slice(5))),
          linked = object(importers[target]);
        if (!Object.keys(linked).length)
          throw new Error(`No workspace importer for ${name}`);
        if (seen.has(target)) return;
        seen.add(target);
        for (const field of ["dependencies", "optionalDependencies"])
          for (const [child, raw] of Object.entries(object(linked[field]))) {
            const record = object(raw);
            if (typeof record.version === "string")
              visit(child, record.version, target);
          }
        return;
      }
      const snapshotKey = `${name}@${reference}`,
        snapshot = object(snapshots[snapshotKey]),
        packageKey = snapshotKey.replace(/\(.*$/, ""),
        pkg = object(packages[packageKey]);
      if (!Object.keys(pkg).length)
        throw new Error(`No lock package for ${name}`);
      const version =
        typeof pkg.version === "string"
          ? pkg.version
          : reference.replace(/\(.*$/, "");
      const entry: Dependency = direct ?? {
        name,
        group: { kind: "runtime" },
        source: sourceOf(reference),
        declared_specifier: "",
        direct: false,
        evidence: { file, field: `snapshots.${snapshotKey}` },
      };
      if (/^\d+\.\d+\.\d+/.test(version)) addResolution(entry, version, file);
      if (seen.has(snapshotKey)) return;
      seen.add(snapshotKey);
      if (!direct && transitive) result.dependencies.push(entry);
      for (const field of ["dependencies", "optionalDependencies"])
        for (const [child, version] of Object.entries(object(snapshot[field])))
          if (typeof version === "string") visit(child, version, from);
    };
    for (const dependency of [...result.dependencies]) {
      const record = object(
        object(importer[declarationField(dependency.group)])[dependency.name],
      );
      if (
        record.specifier !== dependency.declared_specifier ||
        typeof record.version !== "string"
      )
        throw new Error(
          `pnpm lock declaration is stale or missing for ${dependency.name}`,
        );
      visit(dependency.name, record.version, key, dependency);
    }
    return result;
  } catch (error) {
    return unavailable(
      result,
      transitive,
      error instanceof Error ? error.message : "Invalid pnpm lock graph",
    );
  }
}
export const pnpmAdapter: Adapter = {
  groups: jsGroups,
  inventory,
  verify: verifyJs,
  async plan(ctx, request, before) {
    const steps: NativeStep[] = [];
    const { lockDirectory } = await pnpmDirectories(ctx.cwd, ctx.owner);
    if (request.operation === "sync") {
      if (!(await readOptional(join(lockDirectory, "pnpm-lock.yaml"))))
        throw new DependencyError(
          "lock-required",
          "pnpm sync requires an existing lock",
        );
      steps.push({
        label: "Install frozen pnpm environment",
        args: ["install", "--frozen-lockfile"],
        cwd: ctx.cwd,
      });
    } else if (request.operation === "add") {
      if (request.group.kind === "peer")
        throw new DependencyError(
          "unsupported-group-operation",
          "pnpm peer add also writes devDependencies; peer-only add is unavailable",
        );
      for (const p of request.packages) {
        rejectOtherGroups(before, p.name, request.group);
        steps.push(
          step(ctx, `Add ${p.name}`, [
            "add",
            await jsSource(ctx, p.name, p.source, p.version),
            groupFlag(request.group),
          ]),
        );
      }
    } else if (request.operation === "remove") {
      for (const p of request.packages) {
        selectDependency(before, p.name, request.group);
        if (
          before.dependencies.some(
            (d) => d.name === p.name && d.group.kind === "peer",
          ) &&
          before.dependencies.filter((d) => d.name === p.name).length > 1
        )
          throw new DependencyError(
            "unsupported-group-operation",
            "pnpm remove also removes the peer declaration",
          );
      }
      steps.push(
        step(ctx, "Remove selected pnpm dependencies", [
          "remove",
          ...request.packages.map((p) => p.name),
          ...(request.group.kind === "peer" ? [] : [groupFlag(request.group)]),
        ]),
      );
    } else {
      for (const p of request.packages) {
        const dependency = selectDependency(before, p.name, p.group);
        if (dependency.group.kind === "peer")
          throw new DependencyError(
            "unsupported-group-operation",
            "pnpm peer updates cannot preserve peer-only declaration ownership",
          );
        if (dependency.source.kind !== "registry") {
          if (
            p.version ||
            dependency.source.kind === "unknown" ||
            /#[a-f0-9]{40}$/i.test(dependency.declared_specifier)
          )
            throw new DependencyError(
              "unsupported-source-operation",
              "An exact registry version cannot replace a local/Git source; immutable selectors require explicit add",
            );
          rejectOtherGroups(before, p.name, dependency.group);
          steps.push(
            step(ctx, `Refresh ${p.name} from its existing source`, [
              "update",
              p.name,
            ]),
          );
          continue;
        }
        rejectOtherGroups(before, p.name, dependency.group);
        // pnpm 10 retains an existing range operator even with --save-exact.
        // Native removal first gives the subsequent native add an exact declaration.
        if (p.version)
          steps.push(
            step(ctx, `Remove previous ${p.name} range`, [
              "remove",
              p.name,
              groupFlag(dependency.group),
            ]),
          );
        steps.push(
          step(
            ctx,
            `Update ${p.name}`,
            p.version
              ? [
                  "add",
                  `${p.name}@${p.version}`,
                  groupFlag(dependency.group),
                  "--save-exact",
                ]
              : [
                  "update",
                  p.name,
                  dependency.group.kind === "dev" ? "--dev" : "--prod",
                  ...(request.mode === "latest" ? ["--latest"] : []),
                ],
          ),
        );
      }
    }
    // pnpm 10 can persist a relative redirected lock directory twice in its
    // modules state during frozen install. Pass the validated absolute location
    // consistently without rewriting the user's configuration.
    if (lockDirectory !== ctx.owner)
      for (const step of steps) step.args.push("--lockfile-dir", lockDirectory);
    const plan = jsPlan(ctx, "pnpm-lock.yaml", steps);
    const defaultLock = join(ctx.project.managerRoot, "pnpm-lock.yaml");
    plan.metadata = [
      ...new Set([
        ...plan.metadata.filter((file) => file !== defaultLock),
        relative(ctx.root, join(lockDirectory, "pnpm-lock.yaml")),
      ]),
    ];
    return plan;
  },
};
