import { afterEach, expect, spyOn, test } from "bun:test";
import type * as FileSystem from "node:fs";
import * as files from "node:fs/promises";
import * as modules from "node:module";
import { ruffArtifact } from "../../../src/lint/ruff-install";
import type * as Toolchain from "../../../src/lint/toolchain";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const architecture = Object.getOwnPropertyDescriptor(process, "arch");
const restores: (() => void)[] = [];
const testRequire = modules.createRequire(import.meta.url);
const toolchainPath = testRequire.resolve("../../../src/lint/toolchain.ts");

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
  if (platform) {
    Object.defineProperty(process, "platform", platform);
  }
  if (architecture) {
    Object.defineProperty(process, "arch", architecture);
  }
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function environment(os: string, arch: string): void {
  Object.defineProperty(process, "platform", { value: os });
  Object.defineProperty(process, "arch", { value: arch });
}
function isolatedToolchain(): typeof Toolchain {
  const previous = testRequire.cache[toolchainPath];
  delete testRequire.cache[toolchainPath];
  restores.push(() => {
    delete testRequire.cache[toolchainPath];
    if (previous) {
      testRequire.cache[toolchainPath] = previous;
    }
  });
  return testRequire(toolchainPath) as typeof Toolchain;
}
function biomeBoundary(nativePackage: string, report: object) {
  const requests: string[] = [];
  const available = new Map([
    ["@biomejs/biome/package.json", "/extension/biome/package.json"],
    [nativePackage, "/extension/native/biome"],
  ]);
  const resolver = {
    resolve(id: string) {
      requests.push(id);
      const path = available.get(id);
      if (!path) {
        throw new Error(`Package unavailable: ${id}`);
      }
      return path;
    },
  };
  keep(spyOn(modules, "createRequire").mockReturnValue(resolver as unknown as NodeJS.Require));
  const stat = keep(
    spyOn(files, "lstat").mockResolvedValue({
      mode: 0o100755,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as FileSystem.Stats),
  );
  keep(spyOn(process.report, "getReport").mockReturnValue(report));
  return { requests, stat };
}

for (const [os, arch, stem] of [
  ["darwin", "x64", "ruff-x86_64-apple-darwin"],
  ["darwin", "arm64", "ruff-aarch64-apple-darwin"],
  ["linux", "x64", "ruff-x86_64-unknown-linux-gnu"],
  ["linux", "arm64", "ruff-aarch64-unknown-linux-gnu"],
] as const) {
  test(`Ruff selects the official ${os}/${arch} archive member and checksum`, () => {
    environment(os, arch);
    const artifact = ruffArtifact();
    expect({ archive: artifact.archive, entry: artifact.entry, checksums: artifact.checksums }).toEqual({
      archive: `${stem}.tar.gz`,
      entry: `${stem}/ruff`,
      checksums: `${stem}.tar.gz.sha256`,
    });
  });
}

for (const [os, arch, report, nativePackage] of [
  ["darwin", "x64", { header: {} }, "@biomejs/cli-darwin-x64/biome"],
  ["darwin", "arm64", { header: {} }, "@biomejs/cli-darwin-arm64/biome"],
  ["linux", "x64", { header: { glibcVersionRuntime: "2.39" } }, "@biomejs/cli-linux-x64/biome"],
  ["linux", "arm64", { header: { glibcVersionRuntime: "2.39" } }, "@biomejs/cli-linux-arm64/biome"],
  ["linux", "x64", { header: {} }, "@biomejs/cli-linux-x64-musl/biome"],
  ["linux", "arm64", { header: {} }, "@biomejs/cli-linux-arm64-musl/biome"],
] as const) {
  test(`Biome selects ${nativePackage} from ${os}/${arch} runtime metadata`, async () => {
    environment(os, arch);
    const boundary = biomeBoundary(nativePackage, report);
    const toolchain = isolatedToolchain();
    await toolchain.bundledBiome();
    expect(boundary.requests).toEqual(["@biomejs/biome/package.json", nativePackage]);
  });
}

test("repeated Biome resolution detects an executable removed after successful selection", async () => {
  environment("linux", "x64");
  const boundary = biomeBoundary("@biomejs/cli-linux-x64/biome", { header: { glibcVersionRuntime: "2.39" } });
  const toolchain = isolatedToolchain();
  await toolchain.bundledBiome();
  boundary.stat.mockRejectedValueOnce(Object.assign(new Error("Executable removed"), { code: "ENOENT" }));
  await expect(toolchain.bundledBiome()).rejects.toMatchObject({ code: "missing-tool" });
});

for (const [os, arch] of [
  ["win32", "x64"],
  ["linux", "ia32"],
] as const) {
  test(`unsupported ${os}/${arch} is rejected by both native selectors`, async () => {
    environment(os, arch);
    biomeBoundary("@biomejs/cli-linux-x64/biome", { header: {} });
    const toolchain = isolatedToolchain();
    await expect(toolchain.bundledBiome()).rejects.toMatchObject({ code: "unsupported-platform" });
    let failure: unknown;
    try {
      ruffArtifact();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "unsupported-platform" });
  });
}
