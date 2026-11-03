import { expect, test } from "bun:test";
import { type NativeLockSnapshot, resolveReferenceEvidence } from "../../../src/release/native-evidence";
import { type ReleaseManifest } from "../../../src/release/participants";
import { referenceDeclarations } from "../../../src/release/references";

function manifest(name: string, data: Record<string, unknown>): ReleaseManifest {
  return {
    project: {
      project_id: name,
      path: `packages/${name}`,
      manifest: `packages/${name}/package.json`,
      ecosystem: "javascript",
      name,
      manager: "npm",
      managerRoot: ".",
      workspace: "root",
      managerCandidates: ["npm"],
      status: "detected",
      frameworks: [],
      evidence: [],
    },
    participant: {
      project_id: name,
      path: `packages/${name}`,
      manifest: `packages/${name}/package.json`,
      ecosystem: "javascript",
      kind: "static",
      version: "1.0.0",
    },
    snapshot: { text: JSON.stringify(data), identity: "1", mode: 420 },
    data,
  };
}
test("native npm link identity distinguishes same-name registry packages", () => {
  const a = manifest("a", { dependencies: { b: "^1.0.0" } }),
    b = manifest("b", {}),
    declaration = referenceDeclarations(a)[0];
  if (!declaration) {
    throw new Error("declaration missing");
  }
  const lock: NativeLockSnapshot = {
    root: "/repo",
    owner: "/repo",
    directory: "/repo",
    manager: "npm",
    format: "npm",
    document: {
      packages: {
        "node_modules/b": { link: true, resolved: "packages/b" },
        "packages/b": { name: "b", version: "1.0.0" },
      },
    },
  };
  expect(resolveReferenceEvidence(a, declaration, [a, b], lock)).toMatchObject({
    source: "local",
    target_project_id: "b",
    version: "1.0.0",
  });
  lock.document = { packages: { "node_modules/b": { version: "1.0.0", resolved: "https://registry.example/b.tgz" } } };
  expect(resolveReferenceEvidence(a, declaration, [a, b], lock).source).toBe("external");
});
test("pnpm importer linkage remains relative to redirected lock directory", () => {
  const a = manifest("a", { dependencies: { b: "workspace:*" } }),
    b = manifest("b", {}),
    declaration = referenceDeclarations(a)[0];
  if (!declaration) {
    throw new Error("declaration missing");
  }
  const lock: NativeLockSnapshot = {
    root: "/repo",
    owner: "/repo",
    directory: "/repo/locks",
    manager: "pnpm",
    format: "pnpm",
    document: {
      importers: { "../packages/a": { dependencies: { b: { specifier: "workspace:*", version: "link:../b" } } } },
    },
  };
  expect(resolveReferenceEvidence(a, declaration, [a, b], lock)).toMatchObject({
    source: "local",
    target_project_id: "b",
  });
});

test.each(["file:../b", "file:/repo/packages/b"])(
  "Yarn Classic resolves owner-relative file selectors for %s",
  (specifier) => {
    const a = manifest("a", { dependencies: { b: specifier } }),
      b = manifest("b", {});
    const declaration = referenceDeclarations(a)[0];
    if (!declaration) {
      throw new Error("declaration missing");
    }
    const lock: NativeLockSnapshot = {
      root: "/repo",
      owner: "/repo",
      directory: "/repo",
      manager: "yarn",
      format: "classic",
      document: {},
      records: new Map([["b@file:packages/b", { version: "1.0.0", dependencies: {} }]]),
    };
    expect(resolveReferenceEvidence(a, declaration, [a, b], lock)).toMatchObject({
      source: "local",
      target_project_id: "b",
      version: "1.0.0",
    });
  },
);
test("Yarn Classic cannot borrow a relative selector belonging to another owner location", () => {
  const a = manifest("a", { dependencies: { b: "file:../b" } }),
    b = manifest("b", {});
  const declaration = referenceDeclarations(a)[0];
  if (!declaration) {
    throw new Error("declaration missing");
  }
  const lock: NativeLockSnapshot = {
    root: "/repo",
    owner: "/repo",
    directory: "/repo",
    manager: "yarn",
    format: "classic",
    document: {},
    records: new Map([["b@file:../b", { version: "1.0.0", dependencies: {} }]]),
  };
  expect(resolveReferenceEvidence(a, declaration, [a, b], lock).source).toBe("ambiguous");
});
test("Yarn Modern binds relative file locators to their declaring workspace", () => {
  const a = manifest("a", { dependencies: { b: "file:../b" } }),
    b = manifest("b", {});
  const declaration = referenceDeclarations(a)[0];
  if (!declaration) {
    throw new Error("declaration missing");
  }
  const lock: NativeLockSnapshot = {
    root: "/repo",
    owner: "/repo",
    directory: "/repo",
    manager: "yarn",
    format: "modern",
    document: {
      "a@workspace:packages/a": { resolution: "a@workspace:packages/a" },
      "b@file:../b::locator=a%40workspace%3Apackages%2Fa": {
        version: "1.0.0",
        resolution: "b@file:../b#../b::hash=741908&locator=a%40workspace%3Apackages%2Fa",
      },
      "b@file:../b::locator=c%40workspace%3Apackages%2Fc": {
        version: "9.0.0",
        resolution: "b@file:../b#../b::hash=other&locator=c%40workspace%3Apackages%2Fc",
      },
    },
  };
  expect(resolveReferenceEvidence(a, declaration, [a, b], lock)).toMatchObject({
    source: "local",
    target_project_id: "b",
    version: "1.0.0",
  });
  lock.document = Object.fromEntries(
    Object.entries(lock.document).filter(([key]) => key !== "b@file:../b::locator=a%40workspace%3Apackages%2Fa"),
  );
  expect(resolveReferenceEvidence(a, declaration, [a, b], lock).source).toBe("ambiguous");
});
