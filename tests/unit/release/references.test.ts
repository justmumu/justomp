import { expect, test } from "bun:test";
import { type ReleaseManifest } from "../../../src/release/participants";
import {
  type NativeReferenceEvidence,
  planLocalReferences,
  referenceDeclarations,
} from "../../../src/release/references";

function manifest(
  name: string,
  data: Record<string, unknown>,
  ecosystem: "javascript" | "python" = "javascript",
): ReleaseManifest {
  const path = `packages/${name}`;
  return {
    project: {
      project_id: name,
      path,
      name,
      manifest: `${path}/package.json`,
      managerRoot: ".",
      ecosystem,
      workspace: "root",
      manager: ecosystem === "python" ? "uv" : "npm",
      managerCandidates: [],
      status: "detected",
      frameworks: [],
      evidence: [],
    },
    participant: {
      project_id: name,
      path,
      manifest: `${path}/package.json`,
      ecosystem,
      version: "1.2.3",
      kind: "static",
    },
    data,
    snapshot: { text: "{}", identity: "1:1", mode: 420 },
  };
}
function evidence(field: string[], source: NativeReferenceEvidence["source"] = "local"): NativeReferenceEvidence {
  return {
    from: "a",
    name: "b",
    field,
    source,
    ...(source === "local" ? { target_project_id: "b", version: "1.2.3" } : {}),
  };
}
test("local release ranges change only with proven ownership and retain compatible ranges", () => {
  const a = manifest("a", { dependencies: { b: "^1.2.3" } }),
    b = manifest("b", {});
  expect(planLocalReferences([a, b], [evidence(["dependencies", "b"])], "2.0.0")).toEqual([
    {
      manifest: a.project.manifest,
      field: ["dependencies", "b"],
      before: "^1.2.3",
      after: "^2.0.0",
      target_project_id: "b",
    },
  ]);
  expect(planLocalReferences([a, b], [evidence(["dependencies", "b"])], "1.3.0")).toEqual([]);
  expect(planLocalReferences([a, b], [evidence(["dependencies", "b"], "external")], "2.0.0")).toEqual([]);
  expect(() => planLocalReferences([a, b], [], "2.0.0")).toThrow("ownership");
});
test("rolling local references remain unchanged while incompatible peer claims reject", () => {
  const a = manifest("a", { dependencies: { b: "workspace:*" } }),
    b = manifest("b", {});
  expect(planLocalReferences([a, b], [evidence(["dependencies", "b"])], "2.0.0")).toEqual([]);
  a.data = { peerDependencies: { b: "^1.2.3" } };
  expect(() => planLocalReferences([a, b], [evidence(["peerDependencies", "b"])], "2.0.0")).toThrow("compatibility");
});
test("Python local constraints preserve extras, markers and group location", () => {
  const a = manifest("a", { project: { dependencies: ["b[extra] ==1.2.3 ; python_version >= '3.11'"] } }, "python"),
    b = manifest("b", {}, "python");
  expect(referenceDeclarations(a)[0]?.name).toBe("b");
  expect(planLocalReferences([a, b], [evidence(["project", "dependencies", "0"])], "1.3.0")[0]?.after).toBe(
    "b[extra] ==1.3.0 ; python_version >= '3.11'",
  );
});
