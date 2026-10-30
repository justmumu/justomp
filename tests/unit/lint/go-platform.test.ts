import { expect, test } from "bun:test";
import { golangciArtifact } from "../../../src/lint/go/install";

test("unsupported Go lint platform fails artifact selection", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(() => golangciArtifact("2.15.0")).toThrow("not supported");
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }
});
