import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uvAdapter } from "../../../../src/dependencies/adapters/uv";
import { readInventory } from "../../../../src/dependencies/inventory";
import { type AdapterContext, type DependencyRequest } from "../../../../src/dependencies/model";
import { runProcess } from "../../../../src/dependencies/runner";
import { type Project } from "../../../../src/inspect/model";

export async function uvFixture(dependencies = '"uv-demo>=1,<2"') {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-uv-")));
  await mkdir(join(root, "wheels"));
  const python = Bun.which("python3"),
    uv = Bun.which("uv");
  if (!python || !uv) {
    throw new Error("uv and Python must already be installed for the native fixture");
  }
  const script = `import zipfile,sys,os
root=sys.argv[1]
for name,versions,requires in [('uv_demo',['1.0.0','1.5.0','2.0.0'],['uv-child>=1']),('uv_child',['1.0.0'],[])]:
 for version in versions:
  dist=name+'-'+version+'.dist-info'
  with zipfile.ZipFile(os.path.join(root,'wheels',name+'-'+version+'-py3-none-any.whl'),'w') as z:
   z.writestr(dist+'/METADATA','Metadata-Version: 2.1\\nName: '+name+'\\nVersion: '+version+'\\n'+''.join('Requires-Dist: '+r+'\\n' for r in requires))
   z.writestr(dist+'/WHEEL','Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
   z.writestr(dist+'/RECORD','')
`;
  const wheelProcess = Bun.spawn([python, "-c", script, root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await wheelProcess.exited) !== 0) {
    throw new Error(await new Response(wheelProcess.stderr).text());
  }
  await writeFile(
    join(root, "pyproject.toml"),
    `[project]\nname = "uv-app"\nversion = "1.0.0"\nrequires-python = ">=3.9"\ndependencies = [${dependencies}]\n[tool.uv]\npackage = false\n`,
  );
  const project: Project = {
    project_id: "python:pyproject.toml",
    path: ".",
    manifest: "pyproject.toml",
    ecosystem: "python",
    name: "uv-app",
    manager: "uv",
    managerRoot: ".",
    managerCandidates: ["uv"],
    frameworks: [],
    status: "detected",
    evidence: [],
  };
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    UV_CACHE_DIR: join(root, "cache"),
    UV_PYTHON: python,
    UV_PYTHON_DOWNLOADS: "never",
    UV_NO_INDEX: "1",
    UV_FIND_LINKS: join(root, "wheels"),
  };
  const context: AdapterContext = {
    root,
    project,
    cwd: root,
    owner: root,
    manager: "uv",
    version: "0.11.6",
    structure: {
      schemaVersion: 2,
      root,
      scanId: "fixture",
      startedAt: "",
      completedAt: "",
      projects: [project],
      workspaces: [],
      localDependencies: [],
      diagnostics: [],
      excluded: [],
      complete: true,
      metrics: {
        durationMs: 0,
        directoryEntries: 0,
        directories: 0,
        manifestReads: 0,
        manifestBytes: 0,
        parseMs: 0,
        relationshipMs: 0,
        maxConcurrentIO: 0,
      },
    },
    run: (step) =>
      runProcess(uv, step.args, {
        cwd: step.cwd ?? context.cwd,
        env: { ...env, ...step.env },
      }),
  };
  return {
    root,
    context,
    python,
    env,
    async native(args: string[]) {
      const result = await context.run({ args, label: "fixture" });
      if (result.exit_code !== 0) {
        throw new Error(result.stderr);
      }
      return result;
    },
    async execute(request: Exclude<DependencyRequest, { operation: "list" }>) {
      const before = await readInventory(root, context.project);
      const plan = await uvAdapter.plan(context, request, before);
      for (const step of plan.steps) {
        const result = await context.run(step);
        if (result.exit_code !== 0) {
          throw new Error(result.stderr);
        }
      }
      const after = await uvAdapter.inventory(context, false);
      await uvAdapter.verify?.(context, request, before, after);
      return after;
    },
    async manifest() {
      return readFile(join(root, context.project.manifest), "utf8");
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function localPackage(root: string, path: string, name: string) {
  const directory = join(root, path);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "pyproject.toml"),
    `[project]\nname = "${name}"\nversion = "1.0.0"\nrequires-python = ">=3.9"\n[build-system]\nrequires = []\nbuild-backend = "backend"\nbackend-path = ["."]\n`,
  );
  await writeFile(
    join(directory, "backend.py"),
    `import os,zipfile\nNAME = "${name.replaceAll("-", "_")}"\ndef build_wheel(wheel_directory, config_settings=None, metadata_directory=None):\n filename=NAME+'-1.0.0-py3-none-any.whl'\n dist=NAME+'-1.0.0.dist-info'\n with zipfile.ZipFile(os.path.join(wheel_directory,filename),'w') as z:\n  z.writestr(dist+'/METADATA','Metadata-Version: 2.1\\nName: '+NAME+'\\nVersion: 1.0.0\\n')\n  z.writestr(dist+'/WHEEL','Wheel-Version: 1.0\\nGenerator: fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\n  z.writestr(dist+'/RECORD','')\n return filename\ndef build_editable(wheel_directory, config_settings=None, metadata_directory=None):\n return build_wheel(wheel_directory,config_settings,metadata_directory)\n`,
  );
  return directory;
}
