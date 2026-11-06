import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import manifest from "../../package.json";
import { object } from "../dependencies/inventory";
import { LintError } from "./model";

export const RUFF_VERSION = "0.17.3";
export const GOLANGCI_VERSION = "2.15.0";
export const LINT_TOOLCHAIN_ID = "justomp-owned-v1";
export const BIOME_VERSION = manifest.devDependencies["@biomejs/biome"];

const require = createRequire(import.meta.url);

function biomePlatform(): string {
  if (!["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    throw new LintError("unsupported-platform", `Biome is not supported on ${process.platform}/${process.arch}`);
  }
  let suffix = "";
  if (process.platform === "linux") {
    const report = process.report.getReport();
    if (typeof report === "string" || !object(object(report).header).glibcVersionRuntime) {
      suffix = "-musl";
    }
  }
  return `${process.platform}-${process.arch}${suffix}`;
}

/** Resolve from the extension, never from the inspected project's package graph. */
export async function bundledBiome(): Promise<string> {
  const platform = biomePlatform();
  try {
    const biome = createRequire(require.resolve("@biomejs/biome/package.json"));
    const path = biome.resolve(`@biomejs/cli-${platform}/biome`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) {
      throw new Error("Native package binary is not an executable regular file");
    }
    return path;
  } catch (error) {
    throw new LintError(
      "missing-tool",
      `Justomp's native Biome package is unavailable; reinstall Justomp with optional dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
