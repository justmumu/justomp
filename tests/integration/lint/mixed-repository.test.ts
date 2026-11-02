import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProjectLint, prepareLintProjects } from "../../../src/lint";
import { closePackagingStructure, getPackagingStructure } from "../../../src/packaging/get-structure";

test("empty roots and folders have no lint projects; unsupported managers are explicit", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lint-empty-")));
  try {
    await mkdir(join(root, "draft"));
    const empty = await prepareLintProjects(root);
    expect(empty.complete).toBe(true);
    expect(empty.affected_projects).toEqual([]);
    expect(empty.changes).toEqual([]);
    await expect(checkProjectLint(root, "python:pyproject.toml")).rejects.toThrow("Unknown project_id");
    await writeFile(join(root, "package.json"), '{"name":"unsupported","packageManager":"deno@2.0.0"}');
    await getPackagingStructure(root, { refresh: true });
    const unsupported = await prepareLintProjects(root);
    expect(unsupported.complete).toBe(false);
    expect(unsupported.errors.some((error) => error.code === "unsupported-manager")).toBe(true);
  } finally {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
