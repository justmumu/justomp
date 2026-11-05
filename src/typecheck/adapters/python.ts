import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { planUvDevBatch, uvAdapter } from "../../dependencies/adapters/uv";
import { readOptional } from "../../dependencies/executable";
import { object } from "../../dependencies/inventory";
import { type ProcessResult, redact } from "../../dependencies/model";
import { safePath } from "../../dependencies/paths";
import { runProcess } from "../../dependencies/runner";
import { metadataChangeKind } from "../../lint/adapters/metadata";
import { lintManagerContext } from "../../lint/runtime";
import { pyrightOutput } from "../diagnostics/python";
import { type TypecheckCheck, TypecheckError } from "../model";
import { planPythonProjection } from "../projections/python";
import { collectTypecheckScope } from "../scope";
import { type TypecheckTarget } from "../targets";
import { fetchVersionJSON, stableVersion } from "../versions";
import {
  type TypecheckAdapter,
  type TypecheckCheckContext,
  type TypecheckOperationContext,
  type TypecheckToolContext,
} from "./types";

function binary(target: TypecheckTarget, name = "pyright"): string {
  return join(
    resolve(target.scope.owner, target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv"),
    process.platform === "win32" ? "Scripts" : "bin",
    `${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
}
function successful(result: ProcessResult): boolean {
  return result.exit_code === 0 && !result.truncated && !result.cancelled;
}
function nativeFailure(result: ProcessResult, stage: string): never {
  throw new TypecheckError(
    result.cancelled ? "cancelled" : "native-preparation-failed",
    redact(
      `${stage}: ${result.stderr || result.stdout || `exit ${result.exit_code}`}${result.truncated ? " (output truncated)" : ""}`,
    ),
  );
}
async function batch(context: TypecheckOperationContext) {
  const contexts = [];
  let version: string | undefined;
  for (const target of context.targets) {
    const selected = stableVersion(context.versions[target.project.project_id]?.pyright);
    if (version && selected !== version) {
      throw new TypecheckError(
        "invalid-version",
        "Python batch requires the same exact Pyright version for every member",
      );
    }
    version = selected;
    contexts.push(await lintManagerContext(target, context.signal));
  }
  return {
    contexts,
    steps: await planUvDevBatch(contexts, "pyright", version ?? ""),
  };
}

async function pythonBinary(target: TypecheckTarget): Promise<string> {
  const path = binary(target, "python");
  // uv's interpreter is normally a symlink to an installed runtime outside the repo.
  await safePath(target.root, dirname(path));
  return path;
}
async function installedNode(target: TypecheckTarget, signal: AbortSignal): Promise<string> {
  const command = Bun.which("node", {
    PATH: target.scope.env.PATH ?? "",
    cwd: target.scope.cwd,
  });
  if (!command) {
    throw new TypecheckError("runtime-unavailable", "Pyright requires an installed Node runtime");
  }
  const result = await runProcess(command, ["--version"], {
    cwd: target.scope.cwd,
    env: target.scope.env,
    signal,
  });
  if (!successful(result) || !/^v\d+\.\d+\.\d+/.test(result.stdout.trim())) {
    nativeFailure(result, "Node runtime is unavailable");
  }
  return command;
}
function wrapperEnv(target: TypecheckTarget, version: string) {
  return {
    ...target.scope.env,
    PYRIGHT_PYTHON_FORCE_VERSION: version,
    PYRIGHT_PYTHON_IGNORE_WARNINGS: "1",
    PYRIGHT_PYTHON_USE_BUNDLED_PYRIGHT: "1",
  };
}
// Import discovery never calls install_pyright or the wrapper CLI during checks.
const LOCATE = `import json
from pathlib import Path
import pyright
from pyright._utils import ROOT_CACHE_DIR
from pyright._version import __version__, __pyright_version__
p = Path(pyright.__file__).parent / "dist"
if not p.exists(): p = ROOT_CACHE_DIR / __pyright_version__ / "node_modules" / "pyright"
print(json.dumps({"wrapper": __version__, "checker": __pyright_version__, "entry": str(p / "index.js"), "package": str(p / "package.json")}))`;
// Bind the wrapper's subprocess seam to installed executables: neither npm nor
// Node can fall back to nodeenv, while PATH/NODE_OPTIONS keep their native meaning.
const BOOTSTRAP = `import shutil, subprocess
from pyright import node
from pyright.cli import main
def installed(target, *args, **kwargs):
    command = shutil.which(target)
    if command is None:
        raise RuntimeError("Pyright bootstrap requires installed " + target + "; runtime download is disabled")
    return subprocess.run([command, *args], **kwargs)
node.run = installed
raise SystemExit(main(["--version"]))`;

async function checker(context: TypecheckToolContext) {
  const { target, signal } = context;
  const versions: Partial<TypecheckToolContext["versions"]> = context.versions;
  const node = await installedNode(target, signal);
  const python = await pythonBinary(target);
  const found = await runProcess(python, ["-I", "-B", "-c", LOCATE], {
    cwd: target.scope.cwd,
    env: wrapperEnv(target, versions.pyright ?? ""),
    signal,
  });
  if (!successful(found)) {
    nativeFailure(found, "Pyright wrapper is unavailable");
  }
  const info = object(JSON.parse(found.stdout));
  if (
    info.wrapper !== versions.pyright ||
    info.checker !== versions.pyright ||
    typeof info.entry !== "string" ||
    typeof info.package !== "string"
  ) {
    throw new TypecheckError("invalid-version", "Installed Pyright wrapper/checker does not match the exact target");
  }
  const pkg = object(JSON.parse(await readFile(info.package, "utf8")));
  if (pkg.version !== versions.pyright) {
    throw new TypecheckError("invalid-version", "Pyright JavaScript package version does not match the exact target");
  }
  const result = await runProcess(node, [info.entry, "--version"], {
    cwd: target.scope.cwd,
    env: target.scope.env,
    signal,
  });
  if (!successful(result) || result.stdout.trim() !== `pyright ${versions.pyright}`) {
    nativeFailure(result, "Pyright checker version verification failed");
  }
  return { node, entry: info.entry, python };
}
async function assertCurrentProjection(context: TypecheckCheckContext): Promise<void> {
  const current = await planPythonProjection(context.target, context.policy, context.signal);
  const captured = context.projection.input_fingerprint;
  if (!current.current || (captured !== undefined && captured !== current.input_fingerprint)) {
    throw new TypecheckError("outdated-projection", "Pyright native config changed or needs preparation");
  }
}
export const pythonAdapter: TypecheckAdapter = {
  async resolve(targets, _policy, signal) {
    const releases = object(object(await fetchVersionJSON("https://pypi.org/pypi/pyright/json", signal)).releases);
    const candidates = Object.entries(releases)
      .filter(
        ([version, files]) =>
          /^\d+\.\d+\.\d+$/.test(version) &&
          Array.isArray(files) &&
          files.some((file) => object(file).yanked === false),
      )
      .map(([version]) => version)
      .sort((a, b) => {
        const left = a.split(".").map(Number),
          right = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          const delta = (right[i] ?? 0) - (left[i] ?? 0);
          if (delta) {
            return delta;
          }
        }
        return 0;
      });
    const version = stableVersion(candidates[0]);
    return Object.fromEntries(targets.map((target) => [target.project.project_id, { pyright: version }]));
  },
  async preflight(context) {
    const { contexts } = await batch(context);
    for (const [index, native] of contexts.entries()) {
      const target = context.targets[index];
      if (!target) {
        continue;
      }
      await preflightPython(target, native);
    }
    for (const target of context.targets) {
      await installedNode(target, context.signal);
    }
  },
  async prepareBatch(context) {
    const { contexts, steps } = await batch(context);
    const native = contexts[0];
    const first = context.targets[0];
    if (!native || !first) {
      return;
    }
    const metadata = new Map<string, TypecheckTarget>();
    for (const target of context.targets) {
      metadata.set(join(target.root, target.project.manifest), target);
    }
    metadata.set(join(native.owner, "uv.lock"), first);
    const before = new Map<string, string | null>();
    for (const path of metadata.keys()) {
      before.set(path, (await readOptional(path)) ?? null);
    }
    try {
      for (const step of steps) {
        const result = await native.run(step);
        if (!successful(result)) {
          nativeFailure(result, step.label);
        }
      }
      await bootstrapBatch(context);
    } finally {
      await observeMetadata(context, metadata, before);
    }
  },
  async verifyTools(context) {
    try {
      const native = await lintManagerContext(context.target, context.signal);
      const inventory = await uvAdapter.inventory(native, false);
      const pyright = inventory.dependencies.filter((item) => item.name === "pyright");
      if (!inventory.complete || pyright.length !== 1) {
        return false;
      }
      const item = pyright[0];
      if (!item) {
        return false;
      }
      if (
        item.group.kind !== "dev" ||
        item.source.kind !== "registry" ||
        item.marker ||
        item.extras?.length ||
        item.ambiguous ||
        item.declared_specifier !== `==${context.versions.pyright}` ||
        !item.resolutions?.length ||
        item.resolutions.some((value) => value.version !== context.versions.pyright)
      ) {
        return false;
      }
      await checker(context);
      const lock = await native.run({
        args: ["lock", "--check", "--offline"],
        label: "Verify uv lock",
        env: { UV_PYTHON_DOWNLOADS: "never" },
      });
      return successful(lock);
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  plan: planPythonProjection,
  async check(context) {
    const scope = await collectTypecheckScope(context.target);
    const check: TypecheckCheck = {
      status: scope.empty ? "no-sources" : "not-run",
      tool: "pyright",
      version: context.versions.pyright ?? null,
      exit_code: null,
      duration_ms: 0,
      diagnostics: [],
      truncated: false,
      cancelled: false,
    };
    if (scope.empty) {
      return [check];
    }
    const start = performance.now();
    try {
      const native = await checker(context);
      await assertCurrentProjection(context);
      const config = context.projection.configs.check[0];
      if (!config) {
        throw new Error("Missing Pyright check configuration");
      }
      const result = await runProcess(
        native.node,
        [native.entry, "--outputjson", "--pythonpath", native.python, "--project", config],
        {
          cwd: context.target.scope.cwd,
          env: context.target.scope.env,
          signal: context.signal,
        },
      );
      await assertCurrentProjection(context);
      check.exit_code = result.exit_code;
      check.truncated = result.truncated;
      check.cancelled = result.cancelled;
      Object.assign(
        check,
        pyrightOutput(
          {
            root: context.target.root,
            cwd: context.target.scope.cwd,
            project_id: context.target.project.project_id,
            version: context.versions.pyright ?? "",
          },
          result,
          scope.files.length,
        ),
      );
    } catch (error) {
      check.status = "not-run";
      check.reason = redact(error instanceof Error ? error.message : String(error));
      check.cancelled = context.signal.aborted;
    } finally {
      check.duration_ms = performance.now() - start;
    }
    return [check];
  },
};

async function preflightPython(
  target: TypecheckTarget,
  native: Awaited<ReturnType<typeof lintManagerContext>>,
): Promise<void> {
  const environment = resolve(target.scope.owner, target.scope.env.UV_PROJECT_ENVIRONMENT || ".venv");
  const existing = await existingPython(target, environment);
  const data = object(parse(await readFile(join(target.root, target.project.manifest), "utf8")));
  const requirement = object(data.project)["requires-python"];
  // Honor native selection first, then evaluate that exact version against
  // requires-python. uv find otherwise only warns for an incompatible pin.
  const selected = await native.run({
    args: ["python", "find"],
    label: "Find existing Python",
    env: { UV_PYTHON_DOWNLOADS: "never" },
  });
  if (!successful(selected)) {
    nativeFailure(selected, "No compatible installed Python runtime");
  }
  if (existing && (await realpath(selected.stdout.trim())) !== existing) {
    throw new TypecheckError(
      "runtime-conflict",
      "Python runtime would be replaced; reconcile the existing environment and project constraints explicitly",
    );
  }
  if (typeof requirement === "string") {
    const version = await native.run({
      args: ["python", "find", "--show-version", selected.stdout.trim()],
      label: "Inspect selected Python",
      env: { UV_PYTHON_DOWNLOADS: "never" },
    });
    if (!successful(version)) {
      nativeFailure(version, "Could not inspect selected Python runtime");
    }
    const compatible = await native.run({
      args: ["python", "find", `${requirement},==${version.stdout.trim()}`],
      label: "Validate selected Python",
      env: { UV_PYTHON_DOWNLOADS: "never" },
    });
    if (!successful(compatible)) {
      nativeFailure(compatible, "Selected Python runtime does not satisfy project constraints");
    }
  }
}

async function existingPython(target: TypecheckTarget, environment: string): Promise<string | undefined> {
  let existing: string | undefined;
  let environmentExists = false;
  try {
    await lstat(environment);
    environmentExists = true;
    existing = await realpath(binary(target, "python"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || environmentExists) {
      throw new TypecheckError("runtime-unavailable", "Existing Python runtime is damaged; repair it explicitly");
    }
  }
  return existing;
}

async function bootstrapBatch(context: TypecheckOperationContext): Promise<void> {
  for (const target of context.targets) {
    const version = context.versions[target.project.project_id]?.pyright ?? "";
    const result = await runProcess(await pythonBinary(target), ["-I", "-B", "-c", BOOTSTRAP], {
      cwd: target.scope.cwd,
      env: wrapperEnv(target, version),
      signal: context.signal,
    });
    if (!successful(result) || result.stdout.trim() !== `pyright ${version}`) {
      nativeFailure(result, "Pyright bootstrap failed");
    }
    await checker({
      target,
      versions: { pyright: version },
      policy: context.policy,
      signal: context.signal,
    });
  }
}

async function observeMetadata(
  context: TypecheckOperationContext,
  metadata: Map<string, TypecheckTarget>,
  before: Map<string, string | null>,
): Promise<void> {
  for (const [path, target] of metadata) {
    const after = (await readOptional(path)) ?? null,
      previous = before.get(path);
    if (after !== previous) {
      context.changes.push({
        project_id: target.project.project_id,
        path: relative(target.root, path).replaceAll("\\", "/"),
        kind: metadataChangeKind(previous, after),
      });
    }
  }
}
