import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  applyPatchSchema,
  replaceEditSchema,
} from "@oh-my-pi/pi-coding-agent/edit";
import { protectedEditMetadata } from "../../../src/omp/protected-edit-metadata";
import { extractProtectedToolTargets } from "../../../src/omp/protected-targets";

test("provider-qualified model changes keep edit metadata and target parsing aligned", () => {
  const settings = Settings.isolated({
    "edit.mode": "replace",
    "edit.modelVariants": { "openai/gpt": "apply_patch" },
  });
  const before = protectedEditMetadata(settings, undefined);
  expect(before.mode).toBe("replace");
  expect(before.parameters).toBe(replaceEditSchema);
  const model = { provider: "openai", id: "gpt-5" } as NonNullable<
    ExtensionContext["model"]
  >;
  const after = protectedEditMetadata(settings, model);
  expect(after.mode).toBe("apply_patch");
  expect(after.parameters).toBe(applyPatchSchema);
  expect(after.description).not.toBe(before.description);
  expect(
    extractProtectedToolTargets(
      "edit",
      {
        path: "source.txt",
        old_string: "old",
        new_string: "new",
        input: "*** Begin Patch\n*** Delete File: package.json\n*** End Patch",
      },
      after.mode,
    ),
  ).toEqual(["package.json"]);
});
