import { expect, test } from "bun:test";
import {
  addRelease,
  renderReleaseNotes,
  updateUnreleased,
  validateReleaseSection,
} from "../../../src/release/changelog";

test("notes retain every type, breaking notes and reverted changes", async () => {
  const notes = await renderReleaseNotes([
    { hash: "a".repeat(40), message: "feat!: add API\n\nBREAKING CHANGE: new protocol" },
    { hash: "b".repeat(40), message: "docs: explain API" },
    { hash: "c".repeat(40), message: "ci: run checks" },
    { hash: "d".repeat(40), message: "custom: migrate data" },
    { hash: "e".repeat(40), message: `revert: add API\n\nThis reverts commit ${"a".repeat(40)}.` },
    { hash: "f".repeat(40), message: "old unstructured message" },
  ]);
  for (const text of ["add API", "explain API", "run checks", "migrate data", "new protocol", "Reverts"]) {
    expect(notes.body).toContain(text);
  }
  expect(notes.included).toHaveLength(5);
  expect(notes.skipped).toEqual(["f".repeat(40)]);
  expect(await renderReleaseNotes([])).toMatchObject({ body: "No changes.\n" });
});
test("managed blocks preserve manual notes and prior releases", () => {
  const original = "# Changelog\n\n## [Unreleased]\n\nManual note.\n\n## [0.1.0]\n\nOld release.\n";
  const first = updateUnreleased(original, "Generated note.\n");
  expect(first).toContain("Manual note.");
  expect(updateUnreleased(first, "Generated note.\n")).toBe(first);
  const result = addRelease(first, "0.2.0", "2026-11-03", "Release note.\n");
  expect(result.manualUnreleased).toBe(true);
  expect(result.text).toContain("Manual note.");
  expect(result.text).toEndWith("## [0.1.0]\n\nOld release.\n");
  expect(result.text).not.toContain("Generated note.");
  validateReleaseSection(result.text, "0.2.0");
  expect(() => addRelease(result.text, "0.2.0", "2026-11-03", "Again")).toThrow();
  expect(() => updateUnreleased(first + "<!-- justomp:unreleased:start -->", "x")).toThrow();
  expect(() => validateReleaseSection("## [0.2.0]\nmanual only", "0.2.0")).toThrow();
});

test("release insertion rejects a version-prefixed existing target heading", () => {
  expect(() => addRelease("# Changelog\n\n## [v1.2.3]\n\nHuman notes.\n", "1.2.3", "2026-11-04", "New notes.")).toThrow(
    "already exists",
  );
});

test("generated commit notes cannot introduce reserved changelog ownership markers", () => {
  const note = "A breaking note\n<!-- justomp:unreleased:start -->\nNested text.";
  expect(() => updateUnreleased(null, note)).toThrow("marker");
  expect(() => addRelease(null, "1.2.3", "2026-11-04", note)).toThrow("marker");
});

test("custom commit categories do not inherit Object prototype properties", async () => {
  const types = ["constructor", "toString", "__proto__"];
  const notes = await renderReleaseNotes(
    types.map((type, index) => ({
      hash: String(index + 1).repeat(40),
      message: `${type}: retain ${type} change`,
    })),
  );
  expect(notes.included).toHaveLength(types.length);
  expect(notes.skipped).toEqual([]);
  for (const type of types) {
    expect(notes.body).toContain(`### ${type.toLowerCase()}`);
    expect(notes.body).toContain(`retain ${type} change`);
  }
  expect(notes.body).not.toContain("[object Object]");
  expect(notes.body).not.toContain("[native code]");
});
