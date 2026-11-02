import { expect, test } from "bun:test";
import { planUvDevBatch } from "../../../../src/dependencies/adapters/uv";
import { uvFixture } from "./uv-fixture";

for (const name of ["ruff", "pyright"]) {
  for (const declaration of [
    `dependencies=["${name}==1.0"]`,
    `[dependency-groups]\nqa=["${name}==1.0"]`,
    `[project.optional-dependencies]\nlint=["${name}==1.0"]`,
    `[dependency-groups]\ndev=["${name}==1.0; python_version < '3.12'"]`,
    `[dependency-groups]\ndev=["${name}[extra]==1.0"]`,
    `[dependency-groups]\ndev=["${name}==1.0", "${name}>=1"]`,
    `[tool.uv.sources]\n${name}={index="private"}`,
    `[tool.uv.sources]\n${name}=[{index="private",marker="sys_platform == 'linux'"}]`,
  ]) {
    test(`${name} dev batch rejects conflicting supplied declaration: ${declaration}`, async () => {
      const f = await uvFixture("");
      try {
        f.write("pyproject.toml", `[project]\nname="uv-app"\nversion="1"\n${declaration}\n`);
        await expect(planUvDevBatch([f.context], name, "2.0.0")).rejects.toMatchObject({
          code: "lint-dependency-conflict",
        });
      } finally {
        f.close();
      }
    });
  }
}

test("dev batch plans frozen declarations before one owner lock and sync", async () => {
  const f = await uvFixture("");
  try {
    const second = {
      ...f.context,
      cwd: `${f.root}/member`,
      project: {
        ...f.context.project,
        project_id: "python:member/pyproject.toml",
        path: "member",
        manifest: "member/pyproject.toml",
      },
    };
    f.write("member/pyproject.toml", '[project]\nname="member"\nversion="1"\n[dependency-groups]\ndev=["ruff==1.0"]\n');
    const steps = await planUvDevBatch([f.context, second], "ruff", "2.0.0");
    expect(steps.map((step) => step.args)).toEqual([
      ["add", "--frozen", "--dev", "ruff==2.0.0"],
      ["add", "--frozen", "--dev", "ruff==2.0.0"],
      ["lock"],
      ["sync", "--locked", "--group", "dev", "--all-packages"],
    ]);
    expect(steps.map((step) => step.cwd)).toEqual([f.root, second.cwd, f.root, f.root]);
  } finally {
    f.close();
  }
});
