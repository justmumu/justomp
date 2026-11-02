import { expect, spyOn, test } from "bun:test";
import * as changes from "../../../src/dependencies/changes";
import { type PackagingStructure } from "../../../src/inspect/model";
import * as packaging from "../../../src/packaging/get-structure";
import * as git from "../../../src/precommit/git";
import * as selection from "../../../src/precommit/selection";
import { runPrecommit } from "../../../src/precommit/service";
import * as workspace from "../../../src/precommit/workspace";

test("preparation topology changes retain the report and stop before checks or staging", async () => {
  const project = {
    project_id: "python:pyproject.toml",
    path: ".",
    manifest: "pyproject.toml",
    manager: "uv",
    managerRoot: ".",
  };
  const structure = { complete: true, projects: [project], workspaces: [] } as unknown as PackagingStructure;
  const live = { ...structure, projects: [{ ...structure.projects[0], managerRoot: "changed" }] } as PackagingStructure;
  const mocks = [
    spyOn(git, "gitContext").mockResolvedValue({ root: "/repo" } as git.GitContext),
    spyOn(git, "gitlinks").mockResolvedValue([]),
    spyOn(git, "gitText").mockResolvedValue("index"),
    spyOn(git, "stagedRecords").mockResolvedValue([{ status: "M", paths: ["a.py"] }]),
    spyOn(git, "git").mockResolvedValue({
      exit_code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      cancelled: false,
      truncated: false,
    }),
    spyOn(packaging, "getPackagingStructure")
      .mockResolvedValueOnce({ structure } as packaging.PackagingResult)
      .mockResolvedValue({ structure: live } as packaging.PackagingResult),
    spyOn(selection, "sharedInputs").mockResolvedValue(new Map()),
    spyOn(changes, "fingerprint").mockResolvedValue(new Map()),
    spyOn(workspace, "assertWorkspaceBoundary").mockResolvedValue(undefined),
  ];
  let calls = 0;
  const preparation: import("../../../src/precommit/model").GateStage = {
    stage: "preparation",
    success: true,
    complete: true,
    effects: [],
    affected_projects: [],
    details: { prepared: true },
  };
  try {
    const result = await runPrecommit("/repo", undefined, {
      prepare: () => Promise.resolve(preparation),
      run: (stage) => {
        calls++;
        return Promise.resolve({ ...preparation, stage });
      },
    });
    expect(result.errors).toEqual(["Project topology changed during preparation; retry commit"]);
    expect(result.stages).toEqual([preparation]);
    expect(result.success).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.staged_files).toEqual([]);
    expect(calls).toBe(0);
  } finally {
    for (const mock of mocks.reverse()) {
      mock.mockRestore();
    }
  }
});

test("Git helper returns a rejected promise for an already cancelled invocation", async () => {
  const reason = new Error("caller cancelled");
  const result = git.git("/repo", ["status"], AbortSignal.abort(reason));
  expect(result).toBeInstanceOf(Promise);
  await expect(result).rejects.toBe(reason);
});
