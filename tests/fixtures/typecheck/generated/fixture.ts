import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../../../src/config/load";
import { typecheckPolicyKey } from "../../../../src/config/typecheck/resolve";
import {
  closePackagingStructure,
  getPackagingStructure,
} from "../../../../src/packaging/get-structure";
import { javascriptAdapter } from "../../../../src/typecheck/adapters/javascript";
import { applyProjection } from "../../../../src/typecheck/projection";
import { TypecheckStateStore } from "../../../../src/typecheck/state";
import { resolveTypecheckTarget } from "../../../../src/typecheck/targets";
import { measureFixture } from "../../cost-timing";
export async function generatedFixture(next = false, nextVersion = "16.4.3") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "typecheck-generated-")),
  );
  const write = async (path: string, content: unknown) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    if (
      path.endsWith("package.json") &&
      typeof content === "object" &&
      content !== null
    )
      content = {
        ...content,
        devDependencies: Object.fromEntries(
          Object.entries({
            typescript: "7.0.2",
            ...("devDependencies" in content
              ? (content.devDependencies as object)
              : {}),
          }).sort(([a], [b]) => a.localeCompare(b)),
        ),
      };
    await writeFile(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  };
  await write("package.json", {
    name: "fixture",
    private: true,
    type: "module",
    packageManager: "npm@11.12.1",
    workspaces: ["apps/*", "packages/*"],
    devDependencies: { typescript: "7.0.2" },
    ...(next
      ? {
          dependencies: {
            next: nextVersion,
            react: "19.2.0",
            "react-dom": "19.2.0",
          },
          devDependencies: {
            typescript: "7.0.2",
            "@types/node": "24.10.1",
            "@types/react": "19.3.0",
            "@types/react-dom": "19.3.0",
          },
        }
      : {}),
  });
  const signal = new AbortController().signal;
  return {
    root,
    write,
    signal,
    async install() {
      return measureFixture("typecheck.install", async () => {
        const process = Bun.spawn(
          ["npm", "install", "--no-audit", "--no-fund"],
          {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ]);
        if (code) throw new Error(`npm fixture install: ${stdout}\n${stderr}`);
      });
    },
    async project() {
      return measureFixture("typecheck.project", async () => {
        const { structure } = await getPackagingStructure(root, {
          refresh: true,
          publish: false,
        });
        const policy = (await loadConfig(root, { flush: false })).typecheck;
        for (const project of structure.projects)
          if (project.ecosystem === "javascript") {
            const target = await resolveTypecheckTarget(
              structure,
              project.project_id,
            );
            await applyProjection(
              await javascriptAdapter.plan(target, policy, signal),
            );
          }
      });
    },
    async ready(id: string) {
      return measureFixture("typecheck.ready", async () => {
        const { structure } = await getPackagingStructure(root, {
          refresh: true,
          publish: false,
        });
        const policy = (await loadConfig(root, { flush: true })).typecheck;
        const store = await TypecheckStateStore.load(root);
        const ids = structure.projects
          .filter((p) => p.ecosystem === "javascript")
          .map((p) => p.project_id);
        for (const projectId of ids) {
          const target = await resolveTypecheckTarget(structure, projectId);
          await applyProjection(
            await javascriptAdapter.plan(target, policy, signal),
          );
          store.state.projects[projectId] = {
            ecosystem: "javascript",
            tools: { typescript: "7.0.2" },
            policy_hash: typecheckPolicyKey(policy.javascript),
            ready: true,
          };
        }
        store.state.waves.javascript = {
          projects: ids,
          tools: { typescript: "7.0.2" },
          complete: true,
          pending: [],
        };
        await store.save();
        return {
          target: await resolveTypecheckTarget(structure, id),
          policy,
          signal,
          versions: { typescript: "7.0.2" },
        };
      });
    },
    async dispose() {
      await measureFixture("typecheck.cleanup", async () => {
        await closePackagingStructure(root);
        await rm(root, { recursive: true, force: true });
      });
    },
  };
}
