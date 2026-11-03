import { expect, spyOn, test } from "bun:test";
import * as metadata from "../../../src/dependencies/changes";
import * as nativeGit from "../../../src/precommit/git";
import {
  emptyReleaseResult,
  failRelease,
  observeReleaseChanges,
  parseChangedPaths,
} from "../../../src/release/effects";
import { ReleaseError } from "../../../src/release/model";

test("release outcomes keep cancellation and partial effects separate", () => {
  const rejected = emptyReleaseResult("/repo");
  failRelease(rejected, new ReleaseError("dirty-tree", "dirty"), false, false);
  expect(rejected.status).toBe("rejected");
  const cancelled = emptyReleaseResult("/repo");
  failRelease(cancelled, new Error("cancelled"), true, false);
  expect(cancelled.status).toBe("cancelled");
  const partial = emptyReleaseResult("/repo");
  partial.changed_files = ["package.json"];
  failRelease(partial, new Error("native failed"), true, true);
  expect(partial.status).toBe("partial_change");
  expect(partial.cancelled).toBe(true);
  expect(partial.success).toBe(false);
  expect(parseChangedPaths("a file\0nested/b\0", "new\0a file\0")).toEqual(["a file", "nested/b", "new"]);
});

test("incomplete Git readback rejects with unknown effects instead of an empty success", async () => {
  const readback = spyOn(nativeGit, "gitText").mockRejectedValue(new Error("Git read failed"));
  try {
    await expect(observeReleaseChanges("/repo", emptyReleaseResult("/repo"))).rejects.toMatchObject({
      code: "effects-unknown",
    });
  } finally {
    readback.mockRestore();
  }
});

test("effect readback retains ignored metadata changes even when Git observation fails", async () => {
  const git = spyOn(nativeGit, "gitText").mockRejectedValue(new Error("Git unavailable"));
  const files = spyOn(metadata, "fingerprint").mockResolvedValue(new Map([["uv.lock", "new"]]));
  const result = emptyReleaseResult("/repo");
  try {
    await expect(observeReleaseChanges("/repo", result, new Map([["uv.lock", "old"]]))).rejects.toMatchObject({
      code: "effects-unknown",
    });
    expect(result.changed_files).toEqual(["uv.lock"]);
    failRelease(result, new Error("unknown other effects"), true, true);
    expect(result.status).toBe("partial_change");
  } finally {
    git.mockRestore();
    files.mockRestore();
  }
});
