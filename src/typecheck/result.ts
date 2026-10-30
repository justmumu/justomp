import type { Project } from "../inspect/model";
import type {
  TypecheckCheck,
  TypecheckPreparation,
  TypecheckResult,
} from "./model";
import type { PreparationReport } from "./prepare";

export interface TypecheckOutcome {
  preparation: TypecheckPreparation;
  checks: TypecheckCheck[];
  policyHash: string;
  ready: boolean;
  failure?: string;
}

export function publicPreparation(
  id: string,
  report?: PreparationReport,
): TypecheckPreparation {
  return report
    ? {
        status: report.status,
        action: report.action,
        tools: { ...report.projects[id]?.tools },
        affected_projects: [...report.affected_projects],
        changes: structuredClone(report.changes),
        diagnostics: structuredClone(report.diagnostics),
        complete: report.complete,
        cancelled: report.cancelled,
        errors: structuredClone(report.errors),
      }
    : {
        status: "unprepared",
        action: "not-attempted",
        tools: {},
        affected_projects: [id],
        changes: [],
        diagnostics: [],
        complete: false,
        cancelled: false,
        errors: [],
      };
}
export function mergePreparation(
  base: TypecheckPreparation,
  generated: TypecheckPreparation,
  hadReport: boolean,
): TypecheckPreparation {
  return {
    ...generated,
    status: hadReport && !base.complete ? base.status : generated.status,
    action:
      base.action === "waited"
        ? "waited"
        : base.action === "prepared" || generated.action === "prepared"
          ? "prepared"
          : generated.action,
    complete: generated.complete && (!hadReport || base.complete),
    tools: { ...base.tools, ...generated.tools },
    affected_projects: [
      ...new Set([...base.affected_projects, ...generated.affected_projects]),
    ],
    changes: [...base.changes, ...generated.changes],
    diagnostics: [...base.diagnostics, ...generated.diagnostics],
    cancelled: base.cancelled || generated.cancelled,
    errors: [...base.errors, ...generated.errors],
  };
}
/** Compose the public result without filesystem, tool or lifecycle work. */
export function typecheckResult(
  project: Pick<Project, "project_id" | "path" | "ecosystem">,
  result: TypecheckOutcome,
  aborted: boolean,
): TypecheckResult {
  const { preparation, policyHash, ready, failure } = result;
  let { checks } = result;
  if (!checks.length) {
    const tool = { python: "pyright", javascript: "typescript", go: "go" }[
      project.ecosystem
    ];
    checks = [
      {
        status: "not-run",
        tool,
        version: preparation.tools[tool] ?? null,
        exit_code: null,
        duration_ms: 0,
        diagnostics: [],
        truncated: false,
        cancelled: aborted,
        reason: failure ?? "Preparation did not complete",
      },
    ];
  }
  const cancelled = aborted || checks.some((c) => c.cancelled),
    truncated = checks.some((c) => c.truncated);
  const complete =
    ready &&
    !failure &&
    !cancelled &&
    !truncated &&
    checks.every((c) => c.status !== "not-run");
  return {
    project_id: project.project_id,
    relative_path: project.path,
    ecosystem: project.ecosystem,
    policy_hash: policyHash,
    success: complete && checks.every((c) => c.status === "passed"),
    preparation,
    checks,
    diagnostics: [
      ...preparation.diagnostics,
      ...checks.flatMap((c) => c.diagnostics),
    ],
    complete,
    truncated,
    cancelled,
    partial_change: !preparation.complete && preparation.changes.length > 0,
    incomplete_stages: [
      ...(!ready && !checks.some((c) => c.status !== "not-run")
        ? ["preparation"]
        : []),
      ...(checks.some(
        (c) => c.status === "not-run" || c.cancelled || c.truncated,
      )
        ? ["typecheck"]
        : []),
      ...(failure && checks.some((c) => c.status !== "not-run")
        ? ["verification"]
        : []),
    ],
    remediation: [
      ...new Set([
        ...(failure ? [failure] : []),
        ...checks.flatMap((c) => (c.reason ? [c.reason] : [])),
        ...(!ready
          ? [
              "Run prepareProjectTypecheck(root, projectId) or full typecheckProject(root, projectId), resolve setup errors, then check again.",
            ]
          : []),
        ...(truncated
          ? [
              "Native output was truncated; rerun to obtain complete diagnostics.",
            ]
          : []),
      ]),
    ],
  };
}
