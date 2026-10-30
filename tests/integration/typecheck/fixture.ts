import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import type { TypecheckAdapter } from "../../../src/typecheck/adapters/types";
import { startTypecheckCoordinator } from "../../../src/typecheck/coordinator";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
export async function fixture(ecosystem: "python" | "javascript" = "python") {
  const tool = ecosystem === "python" ? "pyright" : "typescript";
  const root = await mkdtemp(join(tmpdir(), "typecheck-lifecycle-"));
  cleanup.push(async () => {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  });
  const add = async (name: string) => {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(
        root,
        name,
        ecosystem === "python" ? "pyproject.toml" : "package.json",
      ),
      ecosystem === "javascript"
        ? JSON.stringify({ name, packageManager: "npm@11.0.0" })
        : `[project]\nname="${name}"\nversion="0.1.0"\n[tool.uv]\nrequired-version="0.11.6"\n`,
    );
  };
  await add("a");
  let resolves = 0,
    prepares = 0,
    fail = "",
    latest = "1.0.0";
  const adapter: TypecheckAdapter = {
    async resolve(targets) {
      resolves++;
      return Object.fromEntries(
        targets.map((t) => [t.project.project_id, { [tool]: latest }]),
      );
    },
    async plan(target) {
      return { target, files: [], current: true, configs: { check: [] } };
    },
    async preflight() {},
    async prepareBatch(context) {
      prepares++;
      for (const target of context.targets) {
        const state = JSON.parse(
          await readFile(join(root, ".justomp/typecheck_state.json"), "utf8"),
        );
        expect(state.waves[ecosystem].tools[tool]).toBe(
          context.versions[target.project.project_id]?.[tool],
        );
        if (target.project.path === fail) throw new Error("fixture failure");
        await writeFile(
          join(target.scope.cwd, "installed.json"),
          JSON.stringify(context.versions[target.project.project_id]),
        );
        context.changes.push({
          project_id: target.project.project_id,
          path: `${target.project.path}/installed.json`,
          kind: "updated",
        });
      }
    },
    async verifyTools(context) {
      try {
        return (
          (await readFile(
            join(context.target.scope.cwd, "installed.json"),
            "utf8",
          )) === JSON.stringify(context.versions)
        );
      } catch {
        return false;
      }
    },
    async check() {
      return [];
    },
  };
  const start = async () => {
    const coordinator = await startTypecheckCoordinator(root, {
      [ecosystem]: adapter,
    });
    cleanup.push(() => coordinator.shutdown());
    return coordinator;
  };
  return {
    root,
    add,
    adapter,
    start,
    counts: () => ({ resolves, prepares }),
    fail: (value: string) => {
      fail = value;
    },
    latest: (value: string) => {
      latest = value;
    },
  };
}
