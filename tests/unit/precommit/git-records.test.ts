import { expect, test } from "bun:test";
import { parseStagedRecords } from "../../../src/precommit/git";

test("NUL records preserve unusual names and both rename endpoints", () => {
  expect(parseStagedRecords("M\0a\nb.ts\0R100\0old name.ts\0:(glob)new.ts\0D\0gone.ts\0")).toEqual([
    { status: "M", paths: ["a\nb.ts"] },
    { status: "R100", paths: ["old name.ts", ":(glob)new.ts"] },
    { status: "D", paths: ["gone.ts"] },
  ]);
  expect(() => parseStagedRecords("R100\0old\0")).toThrow();
  expect(() => parseStagedRecords("M\0unfinished")).toThrow();
});
