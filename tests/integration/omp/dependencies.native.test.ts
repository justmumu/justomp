import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, host, hosts, json, roots } from "./dependencies-fixture";

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("real OMP runner performs native npm discovery, list, add, update, sync and remove", async () => {
  const root = await fixture();
  await mkdir(join(root, "local"));
  await writeFile(
    join(root, "local/package.json"),
    '{"name":"local-tool-package","version":"1.0.0"}',
  );
  const h = await host(root);
  const projects = json(
    await h.getTool("list_projects").execute("projects", {}),
  );
  const project_id = projects.projects.find(
    (p: { relative_path: string }) => p.relative_path === ".",
  ).project_id;
  async function call(operation: string, input: object) {
    const result = await h
      .getTool(`dependency_${operation}`)
      .execute(operation, { project_id, ...input });
    const payload = json(result);
    expect(payload.outcome, JSON.stringify(payload)).toBe("success");
    expect(result.isError).not.toBe(true);
    return payload;
  }
  expect((await call("list", {})).dependencies).toEqual([]);
  await call("add", {
    group: { kind: "runtime" },
    packages: [
      { name: "local-tool-package", source: { kind: "path", path: "local" } },
    ],
  });
  expect((await call("list", {})).dependencies[0].name).toBe(
    "local-tool-package",
  );
  await call("update", { packages: [{ name: "local-tool-package" }] });
  await call("sync", {});
  await call("remove", {
    group: { kind: "runtime" },
    packages: [{ name: "local-tool-package" }],
  });
  expect(
    JSON.parse(await readFile(join(root, "package.json"), "utf8"))
      .dependencies ?? {},
  ).toEqual({});
}, 60_000);
