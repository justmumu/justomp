import { expect, spyOn, test } from "bun:test";
import { RELEASE_DEFAULTS } from "../../../src/config/release/defaults";
import * as files from "../../../src/lint/files";
import * as coordination from "../../../src/release/coordination";
import * as history from "../../../src/release/history";
import * as publication from "../../../src/release/publication";
import { type ReleaseRepository } from "../../../src/release/repository";
import { updateRepositoryChangelog } from "../../../src/release/service";

test("cancelled changelog publication reports uncancelled observed file effects", async () => {
  const controller = new AbortController();
  const repo = {
    git: { root: "/repo" },
    config: { release: RELEASE_DEFAULTS },
    participants: [],
    changelog: { text: null, identity: null, mode: 420 },
  } as unknown as ReleaseRepository;
  const readback = spyOn(files, "readProjectionFile").mockResolvedValue({
    text: "published content",
    identity: "1",
    mode: 420,
  });
  const spies = [
    readback,
    spyOn(coordination, "withReleaseRepository").mockImplementation((_cwd, _signal, work) => work(repo)),
    spyOn(coordination, "assertHead").mockResolvedValue(),
    spyOn(history, "captureHistory").mockResolvedValue({ end: "a".repeat(40), base: null, tag: null, commits: [] }),
    spyOn(publication, "publishReleaseFile").mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("publication cancelled"));
    }),
  ];
  try {
    const result = await updateRepositoryChangelog("/repo", {}, controller.signal);
    expect(result).toMatchObject({
      success: false,
      cancelled: true,
      status: "partial_change",
      changed_files: ["CHANGELOG.md"],
    });
    expect(readback).toHaveBeenCalledWith("/repo", "/repo/CHANGELOG.md");
  } finally {
    for (const spy of spies.reverse()) {
      spy.mockRestore();
    }
  }
});
