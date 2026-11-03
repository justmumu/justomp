import { object as releaseObject } from "../dependencies/inventory";

export { object as releaseObject } from "../dependencies/inventory";

import { type Project } from "../inspect/model";
import { type FileSnapshot } from "../lint/files";
import { ReleaseError, type ReleaseParticipant } from "./model";
import { canonicalVersion } from "./version";

export interface ReleaseManifest {
  project: Project;
  participant: ReleaseParticipant;
  snapshot: FileSnapshot & { text: string };
  data: Record<string, unknown>;
}
export function classifyParticipant(project: Project, data: Record<string, unknown>): ReleaseParticipant {
  const result: ReleaseParticipant = {
    project_id: project.project_id,
    path: project.path,
    manifest: project.manifest,
    ecosystem: project.ecosystem,
    version: null,
    kind: project.ecosystem === "go" ? "repository-version" : "versionless",
  };
  if (project.ecosystem === "go") {
    return result;
  }
  if (project.status !== "detected") {
    throw new ReleaseError("ambiguous-project", `${project.manifest}: resolve the package manager before releasing`);
  }
  const metadata = project.ecosystem === "python" ? releaseObject(data.project) : data;
  if (project.ecosystem === "python") {
    validatePythonVersion(project, data, metadata);
  }
  if (metadata.version === undefined) {
    return result;
  }
  if (project.ecosystem === "javascript" && !["npm", "pnpm", "yarn", "bun"].includes(project.manager ?? "")) {
    throw new ReleaseError(
      "unsupported-manager",
      `${project.manifest}: unsupported release package manager ${project.manager ?? "unknown"}`,
    );
  }
  return { ...result, kind: "static", version: canonicalVersion(metadata.version, project.manifest) };
}

function validatePythonVersion(
  project: Project,
  data: Record<string, unknown>,
  metadata: Record<string, unknown>,
): void {
  if (project.manager !== "uv" || !data.project) {
    throw new ReleaseError(
      "unsupported-version-provider",
      `${project.manifest}: unsupported Python version provider; static uv project.version is required`,
    );
  }
  if (Array.isArray(metadata.dynamic) && metadata.dynamic.includes("version")) {
    throw new ReleaseError(
      "unsupported-version-provider",
      `${project.manifest}: dynamic Python versions are unsupported`,
    );
  }
  if (metadata.version === undefined) {
    throw new ReleaseError("unsupported-version-provider", `${project.manifest}: static project.version is missing`);
  }
}
