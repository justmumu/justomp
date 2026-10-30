import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  executeDependency,
  listProjects,
} from "../../../src/dependencies/service";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { fixture, roots } from "./service-fixture";

afterEach(async () => {
  await closePackagingStructure();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("project selection returns only stable IDs and relative paths", async () => {
  const root = await fixture();
  expect(await listProjects(root)).toEqual({
    projects: [{ project_id: "javascript:package.json", relative_path: "." }],
  });
  expect(
    (
      await executeDependency(
        root,
        "update",
        { project_id: "stale", packages: [{ name: "foo" }] },
        {},
      )
    ).outcome,
  ).toBe("rejected");
});
test("an existing dependency outside the inspected root prevents native mutation", async () => {
  const root = await fixture();
  const manifest =
    '{"name":"fixture","packageManager":"npm@11.12.1","dependencies":{"outside":"file:../outside"}}';
  await writeFile(join(root, "package.json"), manifest);
  const result = await executeDependency(
    root,
    "sync",
    { project_id: "javascript:package.json" },
    {},
  );
  expect(result.outcome).toBe("rejected");
  expect(result.diagnostics?.[0]?.code).toBe("outside-root");
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(manifest);
});
