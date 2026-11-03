import { expect, test } from "bun:test";
import { type Project } from "../../../src/inspect/model";
import { classifyParticipant } from "../../../src/release/participants";

const project: Project = {
  project_id: "js:package.json",
  path: ".",
  manifest: "package.json",
  ecosystem: "javascript",
  manager: "npm",
  managerRoot: ".",
  managerCandidates: ["npm"],
  frameworks: [],
  status: "detected",
  evidence: [],
};
test("classify static, private and versionless packages without inventing metadata", () => {
  expect(classifyParticipant(project, { private: true, version: "1.2.3" }).version).toBe("1.2.3");
  expect(classifyParticipant(project, {}).kind).toBe("versionless");
  expect(classifyParticipant({ ...project, ecosystem: "go", manager: "go" }, {}).kind).toBe("repository-version");
});
test("unsupported dynamic Python and noncanonical versions fail before edits", () => {
  const python = { ...project, ecosystem: "python" as const, manager: "uv", manifest: "pyproject.toml" };
  expect(classifyParticipant(python, { project: { version: "1.2.3" } }).version).toBe("1.2.3");
  expect(() => classifyParticipant(python, { project: { dynamic: ["version"] } })).toThrow("dynamic");
  expect(() =>
    classifyParticipant({ ...python, manager: "poetry" }, { tool: { poetry: { version: "1.0.0" } } }),
  ).toThrow("unsupported");
  expect(() => classifyParticipant(project, { version: "01.2.3" })).toThrow("canonical");
});
