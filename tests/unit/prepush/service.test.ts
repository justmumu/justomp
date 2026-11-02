import { expect, spyOn, test } from "bun:test";
import { type PackagingStructure, type Project } from "../../../src/inspect/model";
import * as packaging from "../../../src/packaging/get-structure";
import * as git from "../../../src/precommit/git";
import * as workspace from "../../../src/precommit/workspace";
import { runPrepush } from "../../../src/prepush/service";

test("discovery deduplicates shared manager scopes but keeps pnpm and Go project checks", async () => {
  const projects = ["uv", "npm", "yarn", "bun", "pnpm", "go"].flatMap((manager) =>
    ["a", "b"].map(
      (member) =>
        ({
          project_id: `${manager}-${member}`,
          path: `${manager}/${member}`,
          manager,
          managerRoot: manager,
        }) as Project,
    ),
  );
  const structure = { complete: true, projects } as PackagingStructure;
  const mocks = [
    spyOn(git, "gitContext").mockResolvedValue({ root: "/repo" } as NonNullable<
      Awaited<ReturnType<typeof git.gitContext>>
    >),
    spyOn(git, "gitlinks").mockResolvedValue([]),
    spyOn(packaging, "getPackagingStructure").mockResolvedValue({
      structure,
    } as Awaited<ReturnType<typeof packaging.getPackagingStructure>>),
    spyOn(workspace, "assertWorkspaceBoundary").mockResolvedValue(undefined),
  ];
  const checked: string[] = [],
    units: string[] = [];
  try {
    const result = await runPrepush("/repo/nested", undefined, {
      prepare: async () => ({
        stage: "preparation",
        success: true,
        complete: true,
        effects: [],
        details: {},
      }),
      run: async (stage, _root, id) => {
        if (stage === "dependency") {
          checked.push(id);
        }
        if (stage === "unit") {
          units.push(id);
        }
        return {
          stage,
          project_id: id,
          success: true,
          complete: true,
          effects: [],
          details: {},
        };
      },
    });
    expect(result.success).toBe(true);
    expect(checked).toEqual(["bun-a", "go-a", "go-b", "npm-a", "pnpm-a", "pnpm-b", "uv-a", "yarn-a"]);
    expect(units).toEqual(projects.map((p) => p.project_id).sort());
  } finally {
    for (const mock of mocks.reverse()) {
      mock.mockRestore();
    }
  }
});
