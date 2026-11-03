import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { uvAdapter } from "../../../../src/dependencies/adapters/uv";
import { type Group } from "../../../../src/dependencies/model";
import { pythonVersionStep, releaseLockStep } from "../../../../src/release/adapters/lock-refresh";
import { localPackage, uvFixture } from "../../../fixtures/dependencies/uv/fixture";

const groups: Group[] = [{ kind: "named", name: "test" }];
test("uv native targeted updates retain bounds, latest expands, exact downgrades and read-only graph includes transitive", async () => {
  const fixture = await uvFixture();
  try {
    const id = fixture.context.project.project_id;
    await fixture.native(["sync", "--resolution", "lowest-direct"]);
    let inventory = await uvAdapter.inventory(fixture.context, true);
    expect(inventory.complete).toBe(true);
    expect(inventory.dependencies.find((d) => d.name === "uv-demo")?.resolutions?.[0]?.version).toBe("1.0.0");
    expect(inventory.dependencies.find((d) => d.name === "uv-child")?.direct).toBe(false);
    const before = await readFile(join(fixture.root, "uv.lock"), "utf8");
    await uvAdapter.inventory(fixture.context, true);
    expect(await readFile(join(fixture.root, "uv.lock"), "utf8")).toBe(before);
    inventory = await fixture.execute({
      operation: "update",
      project_id: id,
      packages: [{ name: "uv-demo" }],
    });
    expect(inventory.dependencies[0]?.resolutions?.[0]?.version).toBe("1.5.0");
    expect(await fixture.manifest()).toContain("<2");
    inventory = await fixture.execute({
      operation: "update",
      project_id: id,
      packages: [{ name: "uv-demo" }],
      mode: "latest",
    });
    expect(inventory.dependencies[0]?.resolutions?.[0]?.version).toBe("2.0.0");
    inventory = await fixture.execute({
      operation: "update",
      project_id: id,
      packages: [{ name: "uv-demo", version: "v1.0" }],
    });
    expect(inventory.dependencies[0]?.declared_specifier).toBe("==1.0");
    expect(inventory.dependencies[0]?.resolutions?.[0]?.version).toBe("1.0.0");
    await rm(join(fixture.root, ".venv"), { recursive: true, force: true });
    await fixture.execute({ operation: "sync", project_id: id, check: true });
    expect(await Bun.file(join(fixture.root, ".venv/pyvenv.cfg")).exists()).toBe(false);
    await fixture.execute({ operation: "sync", project_id: id });
    expect(
      (
        await fixture.native([
          "run",
          "--no-sync",
          "python",
          "-c",
          "import importlib.metadata; print(importlib.metadata.version('uv-demo'))",
        ])
      ).stdout.trim(),
    ).toBe("1.0.0");
    await writeFile(join(fixture.root, "pyproject.toml"), (await fixture.manifest()).replace("==1.0", "==1.5.0"));
    await expect(fixture.execute({ operation: "sync", project_id: id, check: true })).rejects.toThrow();
    await expect(fixture.execute({ operation: "sync", project_id: id })).rejects.toThrow();
  } finally {
    await fixture.dispose();
  }
}, 30000);

for (const group of groups) {
  test(`uv native add/remove isolates ${JSON.stringify(group)}`, async () => {
    const fixture = await uvFixture("");
    try {
      const id = fixture.context.project.project_id;
      const inventory = await fixture.execute({
        operation: "add",
        project_id: id,
        group,
        packages: [{ name: "uv-demo", version: "==1.0.0", source: { kind: "registry" } }],
      });
      expect(inventory.dependencies.find((d) => d.name === "uv-demo")?.group).toEqual(group);
      const after = await fixture.execute({
        operation: "remove",
        project_id: id,
        group,
        packages: [{ name: "uv-demo" }],
      });
      expect(after.dependencies).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  }, 30000);
}

test("uv native path and Git sources remain native sources", async () => {
  const fixture = await uvFixture("");
  try {
    const id = fixture.context.project.project_id;
    const directory = await localPackage(fixture.root, "packages/space dir", "uv-local");
    let inventory = await fixture.execute({
      operation: "add",
      project_id: id,
      group: { kind: "runtime" },
      packages: [
        {
          name: "uv-local",
          source: { kind: "path", path: "packages/space dir" },
        },
      ],
    });
    expect(inventory.dependencies[0]?.source.kind).toBe("path");
    await fixture.execute({
      operation: "remove",
      project_id: id,
      group: { kind: "runtime" },
      packages: [{ name: "uv-local" }],
    });
    for (const args of [
      ["init", "-b", "fixture"],
      ["add", "."],
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"],
    ]) {
      const process = Bun.spawn(["git", ...args], {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await process.exited) !== 0) {
        throw new Error(await new Response(process.stderr).text());
      }
    }
    inventory = await fixture.execute({
      operation: "add",
      project_id: id,
      group: { kind: "dev" },
      packages: [
        {
          name: "uv-local",
          source: {
            kind: "git",
            url: pathToFileURL(directory).href,
            ref: "fixture",
          },
        },
      ],
    });
    expect(inventory.dependencies[0]?.source.kind).toBe("git");
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("uv workspace sources target only the selected member and share owner lock", async () => {
  const fixture = await uvFixture("");
  try {
    await writeFile(
      join(fixture.root, "pyproject.toml"),
      (await fixture.manifest()) + '\n[tool.uv.workspace]\nmembers=["packages/*"]\n',
    );
    await localPackage(fixture.root, "packages/selected", "uv-selected");
    await localPackage(fixture.root, "packages/other", "uv-other");
    const rootProject = fixture.context.project;
    const selected = {
      ...rootProject,
      project_id: "python:packages/selected/pyproject.toml",
      path: "packages/selected",
      manifest: "packages/selected/pyproject.toml",
      name: "uv-selected",
      workspace: "uv:.",
    };
    const other = {
      ...selected,
      project_id: "python:packages/other/pyproject.toml",
      path: "packages/other",
      manifest: "packages/other/pyproject.toml",
      name: "uv-other",
    };
    rootProject.workspace = "uv:.";
    fixture.context.project = selected;
    fixture.context.cwd = join(fixture.root, selected.path);
    fixture.context.structure.projects = [rootProject, selected, other];
    fixture.context.structure.workspaces = [
      {
        id: "uv:.",
        kind: "uv",
        path: ".",
        declaration: "pyproject.toml",
        members: [rootProject.project_id, selected.project_id, other.project_id],
        evidence: [],
        status: "resolved",
      },
    ];
    fixture.env.UV_WORKING_DIR = fixture.root;
    const untouched = await readFile(join(fixture.root, other.manifest), "utf8");
    const inventory = await fixture.execute({
      operation: "add",
      project_id: selected.project_id,
      group: { kind: "runtime" },
      packages: [
        {
          name: "uv-other",
          source: { kind: "workspace", target_project_id: other.project_id },
        },
      ],
    });
    expect(inventory.dependencies[0]?.source.kind).toBe("workspace");
    expect(inventory.dependencies[0]?.resolutions?.[0]?.version).toBe("1.0.0");
    expect(await readFile(join(fixture.root, other.manifest), "utf8")).toBe(untouched);
    expect(await readFile(join(fixture.root, "pyproject.toml"), "utf8")).not.toContain("uv-other");
    const plan = await uvAdapter.plan(
      fixture.context,
      { operation: "sync", project_id: selected.project_id },
      inventory,
    );
    expect(plan.metadata).toContain("uv.lock");
    expect(plan.affectedProjects).toHaveLength(3);
    await fixture.execute({
      operation: "sync",
      project_id: selected.project_id,
    });
    await fixture.execute({
      operation: "remove",
      project_id: selected.project_id,
      group: { kind: "runtime" },
      packages: [{ name: "uv-other" }],
    });
    const beforeReleaseLock = await readFile(join(fixture.root, "uv.lock"), "utf8");
    const selectedVersion = await fixture.context.run(
      pythonVersionStep("1.1.0", join(fixture.root, selected.path), selected.name),
    );
    expect(selectedVersion.exit_code, selectedVersion.stderr).toBe(0);
    expect(await readFile(join(fixture.root, selected.manifest), "utf8")).toContain('version = "1.1.0"');
    expect(await readFile(join(fixture.root, other.manifest), "utf8")).toBe(untouched);
    expect(await readFile(join(fixture.root, "uv.lock"), "utf8")).toBe(beforeReleaseLock);
    for (const project of [rootProject, other]) {
      const result = await fixture.context.run(
        pythonVersionStep("1.1.0", join(fixture.root, project.path), project.name),
      );
      expect(result.exit_code, result.stderr).toBe(0);
    }
    const relock = await fixture.context.run(releaseLockStep("uv", fixture.context.version, fixture.root));
    expect(relock.exit_code, relock.stderr).toBe(0);
    const releaseLock = await readFile(join(fixture.root, "uv.lock"), "utf8");
    expect(releaseLock).toContain('name = "uv-selected"\nversion = "1.1.0"');
    expect(releaseLock).toContain('name = "uv-other"\nversion = "1.1.0"');
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("uv update keeps marker, extras and sibling group declaration; remove is group scoped", async () => {
  const fixture = await uvFixture("\"uv-demo[feature]>=1,<2; python_version >= '3.9'\"");
  try {
    await writeFile(
      join(fixture.root, "pyproject.toml"),
      (await fixture.manifest()) + '\n[dependency-groups]\ndev=["uv-demo>=1"]\n',
    );
    const id = fixture.context.project.project_id;
    await fixture.native(["sync"]);
    const inventory = await fixture.execute({
      operation: "update",
      project_id: id,
      packages: [{ name: "uv-demo", group: { kind: "runtime" } }],
      mode: "latest",
    });
    expect(inventory.dependencies.find((d) => d.group.kind === "runtime")?.extras).toEqual(["feature"]);
    expect(inventory.dependencies.find((d) => d.group.kind === "runtime")?.marker).toBe("python_full_version >= '3.9'");
    expect(inventory.dependencies.find((d) => d.group.kind === "dev")?.declared_specifier).toBe(">=1");
    const after = await fixture.execute({
      operation: "remove",
      project_id: id,
      group: { kind: "dev" },
      packages: [{ name: "uv-demo" }],
    });
    expect(after.dependencies).toHaveLength(1);
    expect(after.dependencies[0]?.group.kind).toBe("runtime");
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("uv explicit registry add replaces a previous local source natively", async () => {
  const fixture = await uvFixture("");
  try {
    await localPackage(fixture.root, "packages/demo", "uv-demo");
    const project_id = fixture.context.project.project_id;
    await fixture.execute({
      operation: "add",
      project_id,
      group: { kind: "runtime" },
      packages: [{ name: "uv-demo", source: { kind: "path", path: "packages/demo" } }],
    });
    const inventory = await fixture.execute({
      operation: "add",
      project_id,
      group: { kind: "runtime" },
      packages: [{ name: "uv-demo", version: "==1.5.0", source: { kind: "registry" } }],
    });
    expect(inventory.dependencies[0]?.source.kind).toBe("registry");
    expect(inventory.dependencies[0]?.resolutions?.[0]?.version).toBe("1.5.0");
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("uv allows the same local source in two groups and retains it on scoped remove", async () => {
  const fixture = await uvFixture("");
  try {
    await localPackage(fixture.root, "packages/local", "uv-local");
    const project_id = fixture.context.project.project_id;
    const packages = [
      {
        name: "uv-local",
        source: { kind: "path" as const, path: "packages/local" },
      },
    ];
    await fixture.execute({
      operation: "add",
      project_id,
      group: { kind: "runtime" },
      packages,
    });
    const inventory = await fixture.execute({
      operation: "add",
      project_id,
      group: { kind: "dev" },
      packages,
    });
    expect(inventory.dependencies).toHaveLength(2);
    const after = await fixture.execute({
      operation: "remove",
      project_id,
      group: { kind: "dev" },
      packages: [{ name: "uv-local" }],
    });
    expect(after.dependencies[0]?.source.kind).toBe("path");
  } finally {
    await fixture.dispose();
  }
}, 30000);

test("uv Git branch update refreshes its commit without becoming registry", async () => {
  const fixture = await uvFixture("");
  try {
    const directory = await localPackage(fixture.root, "packages/git", "uv-git");
    const git = async (args: string[]) => {
      const child = Bun.spawn(["git", ...args], {
        cwd: directory,
        env: fixture.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await child.exited) !== 0) {
        throw new Error(await new Response(child.stderr).text());
      }
    };
    await git(["init", "-b", "fixture"]);
    await git(["add", "."]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
    const project_id = fixture.context.project.project_id;
    await fixture.execute({
      operation: "add",
      project_id,
      group: { kind: "runtime" },
      packages: [
        {
          name: "uv-git",
          source: { kind: "git", url: `file://${directory}`, ref: "fixture" },
        },
      ],
    });
    await writeFile(
      join(directory, "pyproject.toml"),
      (await readFile(join(directory, "pyproject.toml"), "utf8")).replaceAll("1.0.0", "1.1.0"),
    );
    await writeFile(
      join(directory, "backend.py"),
      (await readFile(join(directory, "backend.py"), "utf8")).replaceAll("1.0.0", "1.1.0"),
    );
    await git(["add", "."]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "new version"]);
    const inventory = await fixture.execute({
      operation: "update",
      project_id,
      packages: [{ name: "uv-git" }],
    });
    expect(inventory.dependencies[0]?.source.kind).toBe("git");
    expect(inventory.dependencies[0]?.resolutions?.[0]?.version).toBe("1.1.0");
  } finally {
    await fixture.dispose();
  }
}, 30000);
