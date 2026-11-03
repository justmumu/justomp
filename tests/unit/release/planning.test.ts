import { expect, spyOn, test } from "bun:test";
import * as executable from "../../../src/dependencies/executable";
import { prepareReleaseAdapters } from "../../../src/release/adapters/service";
import * as locks from "../../../src/release/native-evidence";
import { type ReleaseManifest } from "../../../src/release/participants";
import { type ManagerScope, type ReleaseRepository } from "../../../src/release/repository";

function member(name: string, dependencies: Record<string, string>): ReleaseManifest {
  const path = `packages/${name}`,
    manifest = `${path}/package.json`;
  const data = { name, version: "1.0.0", description: "preserve", dependencies };
  return {
    project: {
      project_id: name,
      name,
      path,
      manifest,
      ecosystem: "javascript",
      manager: "npm",
      managerRoot: ".",
      workspace: "root",
      managerCandidates: ["npm"],
      status: "detected",
      frameworks: [],
      evidence: [],
    },
    participant: { project_id: name, path, manifest, ecosystem: "javascript", kind: "static", version: "1.0.0" },
    snapshot: { text: JSON.stringify(data), identity: name, mode: 420 },
    data,
  };
}

test("release planning shares one owner refresh and preserves unrelated manifest metadata", async () => {
  const a = member("a", { b: "^1.0.0", external: "^3.0.0" }),
    b = member("b", {});
  const scope: ManagerScope = { manager: "npm", cwd: "/repo", owner: "/repo", env: {}, domains: [], pnpm: undefined };
  const repo = {
    git: { root: "/repo" },
    manifests: [a, b],
    structure: { projects: [a.project, b.project] },
    scopes: new Map([
      ["a", scope],
      ["b", scope],
    ]),
  } as unknown as ReleaseRepository;
  const resolve = spyOn(executable, "resolveExecutable").mockResolvedValue({
    command: "/tools/npm",
    manager: "npm",
    version: "11.0.0",
    cwd: "/repo",
    owner: "/repo",
    env: {},
  });
  const validate = spyOn(executable, "validatePnpmNativeScope").mockResolvedValue();
  const readLock = spyOn(locks, "readNativeLock").mockResolvedValue({
    root: "/repo",
    owner: "/repo",
    directory: "/repo",
    manager: "npm",
    format: "npm",
    document: {},
  });
  try {
    const plan = await prepareReleaseAdapters(repo, "2.0.0", [
      { from: "a", name: "b", field: ["dependencies", "b"], source: "local", target_project_id: "b", version: "1.0.0" },
      { from: "a", name: "external", field: ["dependencies", "external"], source: "external" },
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(readLock).toHaveBeenCalledTimes(1);
    expect(plan.owners).toHaveLength(1);
    expect(plan.owners[0]?.steps).toMatchObject([
      {
        cwd: "/repo",
        args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      },
    ]);
    expect(plan.files.map((file) => ({ path: file.path, data: JSON.parse(file.content) }))).toEqual([
      {
        path: "packages/a/package.json",
        data: {
          name: "a",
          version: "2.0.0",
          description: "preserve",
          dependencies: { b: "^2.0.0", external: "^3.0.0" },
        },
      },
      {
        path: "packages/b/package.json",
        data: { name: "b", version: "2.0.0", description: "preserve", dependencies: {} },
      },
    ]);
    expect(plan.expected.get("packages/a/package.json")).toEqual({
      name: "a",
      version: "2.0.0",
      description: "preserve",
      dependencies: { b: "^2.0.0", external: "^3.0.0" },
    });
    expect(a.data.version).toBe("1.0.0");
    expect(b.data.version).toBe("1.0.0");
  } finally {
    resolve.mockRestore();
    validate.mockRestore();
    readLock.mockRestore();
  }
});
