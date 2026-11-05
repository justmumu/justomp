import { expect, spyOn, test } from "bun:test";
import * as files from "../../../src/lint/files";
import { nativeInputsCurrent } from "../../../src/native-config/inputs";

test("native inherited input changes invalidate a completed check", async () => {
  const before = { text: '{"javascript":{"jsxRuntime":"classic"}}', identity: "inode:1", mode: 420 };
  const read = spyOn(files, "readProjectionFile").mockResolvedValue(before);
  try {
    const inputs = [{ path: "/repo/config/biome.json", before }];
    expect(await nativeInputsCurrent("/repo", inputs)).toBe(true);
    read.mockResolvedValue({ ...before, text: '{"javascript":{"jsxRuntime":"automatic"}}' });
    expect(await nativeInputsCurrent("/repo", inputs)).toBe(false);
    read.mockResolvedValue({ text: null, identity: null, mode: 420 });
    expect(await nativeInputsCurrent("/repo", inputs)).toBe(false);
    expect(await nativeInputsCurrent("/repo", [])).toBe(true);
  } finally {
    read.mockRestore();
  }
});
