import { afterEach, expect, spyOn, test } from "bun:test";
import { RELEASE_DEFAULTS } from "../../../src/config/release/defaults";
import { type ProcessResult } from "../../../src/dependencies/model";
import * as nativeGit from "../../../src/precommit/git";
import * as adapters from "../../../src/release/adapters/service";
import { type NativeReleasePlan } from "../../../src/release/adapters/types";
import { bumpRepository } from "../../../src/release/bump";
import * as coordination from "../../../src/release/coordination";
import * as effects from "../../../src/release/effects";
import * as history from "../../../src/release/history";
import { ReleaseError } from "../../../src/release/model";
import * as evidence from "../../../src/release/native-evidence";
import * as publication from "../../../src/release/publication";
import { type ReleaseRepository } from "../../../src/release/repository";

const undo: (() => void)[] = [];
function keep<T extends { mockRestore(): void }>(spy: T): T {
  undo.push(() => spy.mockRestore());
  return spy;
}
afterEach(() => {
  for (const restore of undo.splice(0).reverse()) {
    restore();
  }
});
function setup() {
  const repo = {
    git: { root: "/repo" },
    config: { release: RELEASE_DEFAULTS },
    participants: [],
    manifests: [],
    version: { text: "1.0.0\n", identity: "1", mode: 420 },
    changelog: { text: null, identity: null, mode: 420 },
  } as unknown as ReleaseRepository;
  keep(spyOn(coordination, "withReleaseRepository").mockImplementation((_cwd, _signal, work) => work(repo)));
  keep(spyOn(coordination, "assertClean").mockResolvedValue());
  keep(spyOn(coordination, "assertHead").mockResolvedValue());
  keep(spyOn(history, "captureHistory").mockResolvedValue({ end: "a".repeat(40), base: null, tag: null, commits: [] }));
  keep(spyOn(nativeGit, "gitText").mockResolvedValue("index"));
  keep(spyOn(evidence, "gatherNativeReferenceEvidence").mockResolvedValue([]));
  keep(
    spyOn(adapters, "prepareReleaseAdapters").mockResolvedValue({
      repo,
      owners: [],
      files: [],
    } as unknown as NativeReleasePlan),
  );
  keep(spyOn(adapters, "applyReleaseMetadata").mockResolvedValue());
  keep(spyOn(adapters, "executeReleaseSteps").mockResolvedValue());
  keep(spyOn(adapters, "verifyReleaseMetadata").mockResolvedValue());
  keep(
    spyOn(effects, "observeReleaseChanges").mockImplementation((_root, result) => {
      result.changed_files = ["VERSION", "CHANGELOG.md"];
      return Promise.resolve();
    }),
  );
  keep(spyOn(effects, "captureReleaseEffects").mockResolvedValue(new Map()));
  const published: { path: string; content: string }[] = [];
  keep(
    spyOn(publication, "publishReleaseFile").mockImplementation((_root, path, _before, content) => {
      published.push({ path, content });
      return Promise.resolve();
    }),
  );
  return { repo, published };
}
test("bump prepares an explicit version and notes without committing or staging", async () => {
  const { published } = setup();
  const result = await bumpRepository("/repo", { increment: "minor" });
  expect(result.success).toBe(true);
  expect(result.previous_version).toBe("1.0.0");
  expect(result.target_version).toBe("1.1.0");
  expect(published.find((file) => file.path === "VERSION")?.content).toBe("1.1.0\n");
  expect(published.find((file) => file.path === "CHANGELOG.md")?.content).toContain("No changes.");
});
test("preflight rejection and failed native steps never publish final release records", async () => {
  const { published } = setup();
  keep(spyOn(coordination, "assertClean").mockRejectedValue(new Error("dirty tree")));
  expect((await bumpRepository("/repo", { increment: "patch" })).status).toBe("rejected");
  expect(published).toEqual([]);
});
test("native failure reports partial effects and cancellation without final version publication", async () => {
  const { published } = setup();
  const native: ProcessResult = {
    exit_code: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "stopped",
    cancelled: true,
    truncated: false,
  };
  keep(
    spyOn(adapters, "executeReleaseSteps").mockImplementation((_plan, onStep) => {
      onStep({ owner: ".", executable: "npm", args: ["install"], result: native });
      return Promise.reject(new Error("stopped"));
    }),
  );
  keep(
    spyOn(effects, "observeReleaseChanges").mockImplementation((_root, result) => {
      result.changed_files = ["package.json"];
      return Promise.resolve();
    }),
  );
  const result = await bumpRepository("/repo", { increment: "major" });
  expect(result.status).toBe("partial_change");
  expect(result.cancelled).toBe(true);
  expect(result.changed_files).toEqual(["package.json"]);
  expect(published).toEqual([]);
});

test("effect observation failure cannot leave a successful release result", async () => {
  setup();
  keep(
    spyOn(effects, "observeReleaseChanges").mockRejectedValue(
      new ReleaseError("effects-unknown", "readback unavailable"),
    ),
  );
  const result = await bumpRepository("/repo", { increment: "patch" });
  expect(result.success).toBe(false);
  expect(result.status).toBe("failed");
  expect(result.diagnostics).toContainEqual({ code: "effects-unknown", message: "readback unavailable" });
});
