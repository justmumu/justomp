import { expect, spyOn, test } from "bun:test";
import { RELEASE_DEFAULTS } from "../../../src/config/release/defaults";
import { verifyReleaseMetadata } from "../../../src/release/adapters/service";
import { type NativeReleasePlan } from "../../../src/release/adapters/types";
import * as evidence from "../../../src/release/native-evidence";
import { type ReleaseManifest } from "../../../src/release/participants";
import { type NativeReferenceEvidence } from "../../../src/release/references";
import * as repository from "../../../src/release/repository";

test("release verification refuses observed policy or manager scope drift before final publication", async () => {
  const before = {
    git: { root: "/repo" },
    config: { release: RELEASE_DEFAULTS },
    manifests: [],
    scopes: new Map(),
  } as unknown as repository.ReleaseRepository;
  const plan = {
    repo: before,
    expected: new Map(),
    references: [],
    owners: [],
    target: "1.1.0",
    files: [],
  } as unknown as NativeReleasePlan;
  const inspect = spyOn(repository, "inspectReleaseRepository");
  const references = spyOn(evidence, "gatherNativeReferenceEvidence").mockResolvedValue([]);
  try {
    inspect.mockResolvedValue({
      ...before,
      config: { ...before.config, release: { ...RELEASE_DEFAULTS, version_file: "versions/current" } },
    });
    await expect(verifyReleaseMetadata(plan)).rejects.toMatchObject({ code: "metadata-conflict" });
    inspect.mockResolvedValue({
      ...before,
      scopes: new Map([
        ["new", { manager: "npm", cwd: "/repo", owner: "/repo", env: {}, domains: ["changed"], pnpm: undefined }],
      ]),
    });
    await expect(verifyReleaseMetadata(plan)).rejects.toMatchObject({ code: "metadata-conflict" });
    expect(references).not.toHaveBeenCalled();
  } finally {
    inspect.mockRestore();
    references.mockRestore();
  }
});

test("post-refresh verification accepts normalized uv names and rejects incomplete native evidence", async () => {
  const manifest: ReleaseManifest = {
    project: {
      project_id: "root",
      path: ".",
      manifest: "pyproject.toml",
      ecosystem: "python",
      name: "My_Package",
      manager: "uv",
      managerRoot: ".",
      managerCandidates: ["uv"],
      status: "detected",
      frameworks: [],
      evidence: [],
    },
    participant: {
      project_id: "root",
      path: ".",
      manifest: "pyproject.toml",
      ecosystem: "python",
      kind: "static",
      version: "1.1.0",
    },
    snapshot: { text: "", identity: "fixture", mode: 420 },
    data: { project: { name: "My_Package", version: "1.1.0" } },
  };
  const scope: repository.ManagerScope = {
    manager: "uv",
    cwd: "/repo",
    owner: "/repo",
    env: {},
    domains: [],
    pnpm: undefined,
  };
  const repo = {
    git: { root: "/repo" },
    config: { release: RELEASE_DEFAULTS },
    manifests: [manifest],
    scopes: new Map([["root", scope]]),
  } as unknown as repository.ReleaseRepository;
  const lock: evidence.NativeLockSnapshot = {
    root: "/repo",
    owner: "/repo",
    directory: "/repo",
    manager: "uv",
    format: "uv",
    document: { package: [{ name: "my-package", version: "1.1.0", source: { virtual: "." } }] },
  };
  const reference: NativeReferenceEvidence = {
    from: "root",
    name: "local-lib",
    field: ["project", "dependencies", "0"],
    source: "local",
    target_project_id: "lib",
    version: "1.1.0",
  };
  const plan = {
    repo,
    target: "1.1.0",
    files: [],
    references: [reference],
    expected: new Map([["pyproject.toml", manifest.data]]),
    owners: [
      {
        context: { project: manifest.project },
        lockBefore: lock,
        command: "uv",
        steps: [],
      },
    ],
  } as unknown as NativeReleasePlan;
  const inspect = spyOn(repository, "inspectReleaseRepository").mockResolvedValue(repo);
  const references = spyOn(evidence, "gatherNativeReferenceEvidence").mockResolvedValue([reference]);
  const readLock = spyOn(evidence, "readNativeLock").mockResolvedValue(lock);
  try {
    await verifyReleaseMetadata(plan);
    for (const invalid of [
      [],
      [{ ...reference, source: "external" as const }],
      [{ ...reference, target_project_id: "different" }],
      [{ ...reference, version: "1.0.0" }],
    ]) {
      references.mockResolvedValue(invalid);
      await expect(verifyReleaseMetadata(plan)).rejects.toMatchObject({ code: "local-resolution-changed" });
    }
    references.mockResolvedValue([reference]);
    readLock.mockResolvedValue({ ...lock, format: "missing" });
    await expect(verifyReleaseMetadata(plan)).rejects.toMatchObject({ code: "stale-release-lock" });
    const binaryPlan = {
      ...plan,
      owners: plan.owners.map((owner) => ({
        ...owner,
        lockBefore: { ...lock, format: "binary-bun" as const },
      })),
    };
    readLock.mockResolvedValue({ ...lock, format: "bun" });
    await expect(verifyReleaseMetadata(binaryPlan)).rejects.toMatchObject({ code: "lock-format-changed" });
    for (const pkg of [
      { name: "my-package", version: "1.0.0", source: { virtual: "." } },
      { name: "my-package", version: "1.1.0", source: { virtual: "other" } },
      { name: "different-package", version: "1.1.0", source: { virtual: "." } },
    ]) {
      readLock.mockResolvedValue({ ...lock, document: { package: [pkg] } });
      await expect(verifyReleaseMetadata(plan)).rejects.toMatchObject({ code: "stale-release-lock" });
    }
  } finally {
    inspect.mockRestore();
    references.mockRestore();
    readLock.mockRestore();
  }
});
