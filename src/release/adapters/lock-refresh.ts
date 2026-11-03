import { type NativeStep } from "../../dependencies/model";
import { ReleaseError } from "../model";

export function releaseLockStep(manager: string, version: string, owner: string, lockDirectory?: string): NativeStep {
  const common = { cwd: owner, label: `Refresh ${manager} release lock` };
  switch (manager) {
    case "npm":
      return { ...common, args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"] };
    case "pnpm":
      return {
        ...common,
        args: [
          "install",
          "--lockfile-only",
          "--no-frozen-lockfile",
          "--ignore-scripts",
          ...(lockDirectory && lockDirectory !== owner ? ["--lockfile-dir", lockDirectory] : []),
        ],
      };
    case "bun":
      return { ...common, args: ["install", "--lockfile-only", "--ignore-scripts"] };
    case "yarn":
      return Number(version.split(".")[0]) >= 2
        ? {
            ...common,
            args: ["install", "--mode=update-lockfile"],
            env: { YARN_ENABLE_IMMUTABLE_INSTALLS: "false", YARN_ENABLE_SCRIPTS: "false" },
          }
        : { ...common, args: ["install", "--ignore-scripts", "--non-interactive"] };
    case "uv":
      return { ...common, args: ["lock"] };
    default:
      throw new ReleaseError("unsupported-manager", `No release lock adapter for ${manager}`);
  }
}
export function pythonVersionStep(target: string, cwd: string, packageName?: string): NativeStep {
  return {
    cwd,
    args: ["version", target, "--frozen", ...(packageName ? ["--package", packageName] : [])],
    env: { UV_WORKING_DIR: cwd, UV_PYTHON_DOWNLOADS: "never" },
    label: "Update static Python release version",
  };
}
