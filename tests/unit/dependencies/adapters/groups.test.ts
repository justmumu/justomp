import { expect, test } from "bun:test";
import { bunAdapter } from "../../../../src/dependencies/adapters/bun";
import { npmAdapter } from "../../../../src/dependencies/adapters/npm";
import { pnpmAdapter } from "../../../../src/dependencies/adapters/pnpm";
import { uvAdapter } from "../../../../src/dependencies/adapters/uv";
import { yarnClassicAdapter } from "../../../../src/dependencies/adapters/yarn-classic";
import { yarnModernAdapter } from "../../../../src/dependencies/adapters/yarn-modern";
import { type Adapter, type Group, type Inventory } from "../../../../src/dependencies/model";
import { memoryContext } from "../memory";
import { uvFixture } from "./uv-fixture";

const managers: [string, Adapter, string, string][] = [
  ["npm", npmAdapter, "npm", "11.12.1"],
  ["pnpm", pnpmAdapter, "pnpm", "10.20.0"],
  ["classic", yarnClassicAdapter, "yarn", "1.22.22"],
  ["modern", yarnModernAdapter, "yarn", "4.12.0"],
  ["bun", bunAdapter, "bun", "1.4.2"],
];
const groups = ["runtime", "dev", "optional", "peer"] as const;
for (const [name, adapter, manager, version] of managers) {
  for (const kind of groups) {
    if (name === "pnpm" && kind === "peer") {
      continue;
    } // Unsupported peer operation has its own rejection test.
    test(`${name} translates ${kind} add/remove and preserves untargeted declarations`, async () => {
      const f = memoryContext({ manager, managerCandidates: [manager] });
      f.context.version = version;
      f.write("package.json", JSON.stringify({ name: "app" }));
      const empty: Inventory = {
        complete: true,
        diagnostics: [],
        dependencies: [],
      };
      const group = { kind };
      const request = {
        operation: "add" as const,
        project_id: f.context.project.project_id,
        group,
        packages: [
          {
            name: "pkg",
            version: "1.0.0",
            source: { kind: "registry" as const },
          },
        ],
      };
      try {
        const plan = await adapter.plan(f.context, request, empty);
        const flags =
          name === "npm" || name === "pnpm"
            ? [`--save-${kind === "runtime" ? "prod" : kind}`]
            : kind === "runtime"
              ? []
              : [`--${kind}`];
        const args = plan.steps[0]?.args ?? [];
        expect(args).toContain("pkg@1.0.0");
        expect(args.filter((a) => a.startsWith("--"))).toEqual(flags);
        const after: Inventory = {
          ...empty,
          dependencies: [
            {
              name: "pkg",
              group,
              source: { kind: "registry" },
              declared_specifier: "1.0.0",
              direct: true,
              evidence: { file: "package.json", field: "supplied" },
            },
          ],
        };
        const remove = await adapter.plan(
          f.context,
          {
            operation: "remove",
            project_id: f.context.project.project_id,
            group,
            packages: [{ name: "pkg" }],
          },
          after,
        );
        const field = {
          runtime: "dependencies",
          dev: "devDependencies",
          optional: "optionalDependencies",
          peer: "peerDependencies",
        }[kind];
        let removal: string[][];
        if (name === "npm") {
          removal = [["pkg", "delete", `${field}[pkg]`], ["install"]];
        } else if (name === "bun") {
          removal = [["pm", "pkg", "delete", `${field}.pkg`], ["install"]];
        } else if (name === "pnpm") {
          removal = [["remove", "pkg", ...flags]];
        } else {
          removal = [["remove", "pkg"]];
        }
        expect(remove.steps.map((step) => step.args)).toEqual(removal);
        const selected = after.dependencies[0];
        if (!selected) {
          throw new Error("missing supplied dependency");
        }
        const sibling = {
          ...selected,
          name: "unrelated",
          declared_specifier: "^2.0.0",
        };
        const before = { ...empty, dependencies: [sibling] };
        await adapter.verify?.(f.context, request, before, {
          ...empty,
          dependencies: [...after.dependencies, sibling],
        });
        await expect(
          Promise.resolve().then(() => adapter.verify?.(f.context, request, before, after)),
        ).rejects.toMatchObject({ code: "postcondition-failed" });
      } finally {
        f.close();
      }
    });
  }
}
for (const [group, flags] of [
  [{ kind: "runtime" }, []],
  [{ kind: "dev" }, ["--dev"]],
  [{ kind: "named", name: "test" }, ["--group", "test"]],
  [{ kind: "extra", name: "speed" }, ["--optional", "speed"]],
] as [Group, string[]][]) {
  test(`uv translates ${JSON.stringify(group)} without installing an environment`, async () => {
    const f = await uvFixture("");
    const before = await uvAdapter.inventory(f.context, false);
    try {
      const add = await uvAdapter.plan(
        f.context,
        {
          operation: "add",
          project_id: f.context.project.project_id,
          group,
          packages: [
            {
              name: "uv-demo",
              version: "==1.0.0",
              source: { kind: "registry" },
            },
          ],
        },
        before,
      );
      expect(add.steps[0]?.args).toEqual(["add", ...flags, "uv-demo==1.0.0"]);
      const supplied: Inventory = {
        ...before,
        dependencies: [
          {
            name: "uv-demo",
            group,
            source: { kind: "registry" },
            declared_specifier: "==1.0.0",
            direct: true,
            evidence: { file: "pyproject.toml", field: "supplied" },
          },
        ],
      };
      const remove = await uvAdapter.plan(
        f.context,
        {
          operation: "remove",
          project_id: f.context.project.project_id,
          group,
          packages: [{ name: "uv-demo" }],
        },
        supplied,
      );
      expect(remove.steps[0]?.args).toEqual(["remove", ...flags, "uv-demo"]);
    } finally {
      f.close();
    }
  });
}
