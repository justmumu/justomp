import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { pnpmDirectories } from "../../../src/dependencies/executable";
import { readInventory } from "../../../src/dependencies/inventory";
import { suppliedResponse } from "../../response";
import { context } from "./adapters/npm-pnpm-fixture";

function suppliedFirst(text: string) {
  let reads = 0;
  const read = spyOn(fs, "readFile").mockImplementation(((_path: unknown, encoding?: unknown) => {
    return suppliedResponse(() => {
      if (reads++) {
        throw Object.assign(new Error("later input unreadable"), {
          code: "EACCES",
        });
      }
      return encoding === "utf8" ? text : Buffer.from(text);
    });
  }) as typeof fs.readFile);
  return { read, count: () => reads };
}
test("pnpm rejects the first invalid INI before reading later configuration", async () => {
  const f = suppliedFirst("[section]\nmodules-dir=x\n");
  try {
    await expect(pnpmDirectories("/repo", "/repo")).rejects.toMatchObject({
      code: "unsupported-config",
    });
    expect(f.count()).toBe(1);
  } finally {
    f.read.mockRestore();
  }
});
test("Python member parse failure precedes owner manifest IO", async () => {
  const f = suppliedFirst("[project\n"),
    project = {
      ...context("npm").project,
      ecosystem: "python" as const,
      manifest: "member/pyproject.toml",
      path: "member",
      managerRoot: ".",
    };
  try {
    await expect(readInventory("/repo", project)).rejects.toThrow("Invalid TOML document");
    expect(f.count()).toBe(1);
  } finally {
    f.read.mockRestore();
  }
});
