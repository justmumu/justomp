import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closePackagingStructure, getPackagingStructure } from "../../../src/packaging/get-structure";
import { type TestAdapter, type TestRunContext } from "../../../src/testing/adapters";
import { resolveTestTarget } from "../../../src/testing/targets";
import { measureFixture } from "../../fixtures/cost-timing";
export async function nativeFixture(runner: "pytest" | "vitest" | "bun" | "go", adapter: TestAdapter) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `justomp-test-${runner}-`)));
  const put = async (path: string, text: string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  };
  try {
    if (runner === "vitest") {
      await put(".npmrc", "audit=false\nfund=false\n");
    }
    if (runner === "go") {
      await put("go.mod", "module example.test/app\ngo 1.25\n");
    } else if (runner === "pytest") {
      await put(
        "pyproject.toml",
        '[project]\nname="native-tests"\nversion="0.1.0"\nrequires-python=">=3.11"\n[tool.uv]\nrequired-version="==0.11.6"\n[tool.pytest.ini_options]\npythonpath=["src"]\naddopts="-x --cov-fail-under=100 --import-mode=importlib --strict-markers"\n',
      );
    } else {
      await put(
        "package.json",
        JSON.stringify({
          name: "native-tests",
          type: "module",
          packageManager:
            runner === "bun"
              ? "bun@1.4.2"
              : `npm@${(await import("node:child_process")).execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()}`,
          scripts: { test: runner === "bun" ? "bun test" : "vitest run" },
        }),
      );
    }
    const { structure } = await getPackagingStructure(root, {
      refresh: true,
      publish: false,
    });
    const target = await resolveTestTarget(structure, structure.projects[0]?.project_id ?? "missing"),
      signal = AbortSignal.timeout(60000);
    const tools = await adapter.resolve([target], signal),
      context = { target, tools, signal };
    await measureFixture(`test-${runner}:setup`, async () => {
      await adapter.preflight(context);
      await adapter.prepare(context, []);
      if (!(await adapter.verify(context))) {
        throw new Error(`${runner} preparation did not verify`);
      }
    });
    let calls = 0;
    const run = async (
      tests: string[],
      sources: string[],
      mode: "full" | "targeted" = "full",
      options: {
        suite?: "unit" | "integration";
        integration?: string[];
        configFile?: string;
      } = {},
    ) => {
      const artifacts = join(root, `.reports-${++calls}`);
      await mkdir(artifacts);
      const context: TestRunContext = {
        target: {
          ...target,
          ...(options.configFile ? { configFile: join(root, options.configFile) } : {}),
        },
        tools,
        signal,
        suite: options.suite ?? "unit",
        mode,
        artifacts,
        remainingMs: () => 30000,
        scope: {
          tests,
          selected: tests,
          sources,
          fingerprint: "",
          integration: options.integration ?? [],
        },
        policy: {
          include: [],
          exclude: [],
          source: { include: [], exclude: [] },
          coverage: {
            enabled: options.suite !== "integration",
            minimum: options.suite === "integration" ? 0 : 70,
          },
        },
      };
      return adapter.run(context);
    };
    return {
      root,
      put,
      run,
      dispose: async () => {
        await closePackagingStructure(root);
        await measureFixture(`test-${runner}:cleanup`, () => rm(root, { recursive: true, force: true }));
      },
    };
  } catch (error) {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
