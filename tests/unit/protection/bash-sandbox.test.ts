import { expect, test } from "bun:test";
import {
  buildSandboxArgv,
  createSandboxCommand,
  sandboxPaths,
} from "../../../src/protection/sandbox";

test("sandbox paths are literal absolute names and deterministic", () => {
  expect(
    sandboxPaths([
      "/repo/a[1]/package.json",
      "/repo/package.json",
      "/repo/package.json",
    ]),
  ).toEqual(["/repo/a[1]/package.json", "/repo/package.json"]);
  expect(() => sandboxPaths(["package.json"])).toThrow("absolute");
  expect(() => sandboxPaths(["/repo/../package.json"])).toThrow("normalized");
  expect(() => sandboxPaths(["/repo/invalid\0name"])).toThrow("NUL");
});

test("macOS profile denies only literal targets and moving their parents", () => {
  const argv = buildSandboxArgv("darwin", "/usr/bin/sandbox-exec", {
    command: "printf '%s' 'quoted $value; still data'",
    cwd: "/repo",
    protectedPaths: ["/repo/a[1]/package.json"],
  });
  expect(argv[0]).toBe("/usr/bin/sandbox-exec");
  expect(argv[2]).toContain("(allow default)");
  expect(argv[2]).toContain(
    '(deny file-write* (subpath "/repo/a[1]/package.json"))',
  );
  expect(argv[2]).toContain('(literal "/repo/a[1]")');
  expect(argv[2]).not.toContain("network");
  expect(argv[2]).not.toContain(".bashrc");
  expect(argv.slice(-3)).toEqual([
    "/bin/bash",
    "-c",
    "printf '%s' 'quoted $value; still data'",
  ]);
});

test("Linux argv pins parent paths before readonly targets and preserves networking", () => {
  const argv = buildSandboxArgv("linux", "/usr/bin/bwrap", {
    command: "echo test; true",
    cwd: "/repo",
    protectedPaths: ["/repo/apps/api/pyproject.toml", "/repo/uv.lock"],
  });
  expect(argv).toContain("--disable-userns");
  expect(argv).toContain("--die-with-parent");
  expect(argv).not.toContain("--unshare-net");
  const readonly = argv.indexOf("--ro-bind");
  expect(argv.slice(readonly, readonly + 3)).toEqual([
    "--ro-bind",
    "/repo/apps/api/pyproject.toml",
    "/repo/apps/api/pyproject.toml",
  ]);
  expect(argv.indexOf("/repo/apps")).toBeLessThan(readonly);
  expect(argv.slice(-6)).toEqual([
    "--chdir",
    "/repo",
    "--",
    "/bin/bash",
    "-c",
    "echo test; true",
  ]);
});

test("unsupported platforms and malformed cwd fail before a command is built", () => {
  const request = {
    command: "echo never",
    cwd: "/repo",
    protectedPaths: ["/repo/package.json"],
  };
  expect(() => buildSandboxArgv("win32", "sandbox", request)).toThrow(
    "macOS and Linux",
  );
  expect(() =>
    buildSandboxArgv("linux", "bwrap", { ...request, cwd: "repo" }),
  ).toThrow("absolute");
});

test("aborted preparation produces no launch descriptor", async () => {
  await expect(
    createSandboxCommand({
      command: "touch never",
      cwd: "/unused",
      protectedPaths: [],
      signal: AbortSignal.abort(new Error("cancelled-before-launch")),
    }),
  ).rejects.toThrow("cancelled-before-launch");
});
