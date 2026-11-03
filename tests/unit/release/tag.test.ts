import { expect, test } from "bun:test";
import { assertReleaseRemote, classifyTagReadback, parseReleaseRemote } from "../../../src/release/tag";

const head = "a".repeat(40),
  other = "b".repeat(40);
test("release tag requires the live default branch and exact published commit", () => {
  const remote = parseReleaseRemote(`ref: refs/heads/trunk\tHEAD\n${head}\tHEAD\n`, "v1.2.3");
  expect(remote).toEqual({ branch: "trunk", head, tag: null });
  expect(() => assertReleaseRemote(remote, "trunk", head)).not.toThrow();
  for (const [branch, commit] of [
    [null, head],
    ["main", head],
    ["trunk", other],
  ]) {
    expect(() => assertReleaseRemote(remote, branch ?? null, commit ?? "")).toThrow();
  }
  expect(() => parseReleaseRemote(`${head}\tHEAD\n`, "v1.2.3")).toThrow("symbolic");
  const existing = parseReleaseRemote(
    `ref: refs/heads/trunk\tHEAD\n${head}\tHEAD\n${other}\trefs/tags/v1.2.3\n${head}\trefs/tags/v1.2.3^{}\n`,
    "v1.2.3",
  );
  expect(existing.tag).toBe(head);
  expect(() => assertReleaseRemote(existing, "trunk", head)).toThrow("already exists");
});
test("tag creation readback distinguishes absence, observed creation and unknown outcomes", () => {
  expect(classifyTagReadback({ exists: false, target: null, annotated: false }, head)).toEqual({
    created: false,
    observed_target: null,
    verified: false,
  });
  expect(classifyTagReadback({ exists: true, target: head, annotated: true }, head)).toEqual({
    created: true,
    observed_target: head,
    verified: true,
  });
  expect(classifyTagReadback(null, head)).toEqual({ created: null, observed_target: null, verified: false });
  expect(classifyTagReadback({ exists: true, target: other, annotated: true }, head)).toEqual({
    created: true,
    observed_target: other,
    verified: false,
  });
});

import { afterEach, spyOn } from "bun:test";
import { RELEASE_DEFAULTS } from "../../../src/config/release/defaults";
import { type ProcessResult } from "../../../src/dependencies/model";
import * as nativeGit from "../../../src/precommit/git";
import { addRelease } from "../../../src/release/changelog";
import * as coordination from "../../../src/release/coordination";
import { type ReleaseRepository } from "../../../src/release/repository";
import { tagRepository } from "../../../src/release/tag";

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
function native(stdout: string, exit_code = 0): ProcessResult {
  return { stdout, exit_code, stderr: "", signal: null, cancelled: false, truncated: false };
}
function tagTextResponse(args: readonly string[]): string {
  switch (args[0]) {
    case "remote":
      return "origin\n";
    case "show":
      return args[1]?.endsWith(":VERSION") ? "1.2.3\n" : addRelease(null, "1.2.3", "2026-11-03", "No changes.").text;
    case "ls-remote":
      return `ref: refs/heads/main\tHEAD\n${head}\tHEAD\n`;
    case "for-each-ref":
      return "v1.2.2\n";
    case "cat-file":
      return "tag\n";
    default:
      return head + "\n";
  }
}
test("cancelled tag process still reports its observed annotated tag", async () => {
  const controller = new AbortController();
  let created = false;
  const tagObject = "c".repeat(40);
  let cleanupWasUncancelled = false;
  const repo = {
    git: { root: "/repo" },
    config: { release: RELEASE_DEFAULTS },
    participants: [],
    manifests: [],
    version: { text: "1.2.3\n" },
  } as unknown as ReleaseRepository;
  keep(spyOn(coordination, "withReleaseRepository").mockImplementation((_cwd, _signal, work) => work(repo)));
  keep(spyOn(coordination, "assertClean").mockResolvedValue());
  keep(spyOn(coordination, "assertHead").mockResolvedValue());
  keep(spyOn(nativeGit, "gitText").mockImplementation((_root, args) => Promise.resolve(tagTextResponse(args))));
  keep(
    spyOn(nativeGit, "git").mockImplementation((_root, args, signal) => {
      if (args[0] === "symbolic-ref") {
        return Promise.resolve(native("main\n"));
      }
      if (args[0] === "tag") {
        created = true;
        controller.abort();
        return Promise.resolve({ ...native("", 1), cancelled: true, signal: "SIGTERM" });
      }
      if (created) {
        cleanupWasUncancelled = signal === undefined;
        return Promise.resolve(native(args.at(-1)?.endsWith("^{commit}") ? head + "\n" : tagObject + "\n"));
      }
      return Promise.resolve(native("", 1));
    }),
  );
  const result = await tagRepository("/repo", {}, controller.signal);
  expect(result.status).toBe("partial_change");
  expect(result.cancelled).toBe(true);
  expect(result.created).toBe(true);
  expect(result.observed_target).toBe(head);
  expect(cleanupWasUncancelled).toBe(true);
  expect(result.success).toBe(false);
});
