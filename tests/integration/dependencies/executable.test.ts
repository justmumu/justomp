import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutable } from "../../../src/dependencies/executable";
import { inspectProject } from "../../../src/inspect/scan";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function resolveUv(requirement: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "justomp-manager-version-")),
  );
  roots.push(root);
  await writeFile(
    join(root, "pyproject.toml"),
    `[project]\nname="fixture"\nversion="1"\n[tool.uv]\nrequired-version="${requirement}"\n`,
  );
  const project = (await inspectProject({ root })).projects[0];
  if (!project) throw new Error("missing fixture");
  return resolveExecutable(root, project);
}
test("uv excluded versions are rejected rather than interpreted as npm ranges", async () => {
  await expect(resolveUv("!=0.11.6")).rejects.toMatchObject({
    code: "manager-version-mismatch",
  });
});
test("uv compatible release requirements retain PEP 440 upper bounds", async () => {
  expect((await resolveUv("~=0.10")).version).toBe("0.11.6");
  await expect(resolveUv("~=0.10.0")).rejects.toMatchObject({
    code: "manager-version-mismatch",
  });
  expect((await resolveUv(">=0.11,!=0.11.5,<0.12")).version).toBe("0.11.6");
});
