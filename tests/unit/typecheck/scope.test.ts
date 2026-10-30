import { expect, test } from "bun:test";
import { resolveTypecheckTarget } from "../../../src/typecheck/targets";
import { target } from "../checks/fixture";

test("incomplete inspection cannot select a typecheck target", async () => {
  const selected = target("go");
  await expect(
    resolveTypecheckTarget(
      { ...selected.structure, complete: false },
      selected.project.project_id,
    ),
  ).rejects.toThrow("complete");
});
