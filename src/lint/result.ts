import { redact } from "../dependencies/model";
import type { Project } from "../inspect/model";
import type { LintCheck, LintPreparation, LintResult } from "./model";

export interface LintOutcome {
  preparation: LintPreparation;
  checks: LintCheck[];
  policyHash: string;
  selectedReady: boolean;
  failure?: string;
}
/** Compose the public result from completed stages and preparation evidence. */
export function lintResult(
  project: Pick<Project, "project_id" | "path" | "ecosystem">,
  outcome: LintOutcome,
  aborted: boolean,
): LintResult {
  const { preparation, checks, policyHash, selectedReady, failure } = outcome;
  const cancelled = aborted || checks.some((c) => c.cancelled);
  const truncated = checks.some((c) => c.truncated);
  const complete =
    !failure &&
    selectedReady &&
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
    diagnostics: checks.flatMap((c) => c.diagnostics),
    complete,
    truncated,
    cancelled,
    partial_change: !preparation.complete && preparation.changes.length > 0,
    incomplete_stages: [
      ...(!selectedReady ? ["preparation"] : []),
      ...checks
        .filter((c) => c.status === "not-run" || c.truncated || c.cancelled)
        .map((c) => c.kind),
      ...(failure && checks.some((c) => c.status !== "not-run")
        ? ["verification"]
        : []),
    ],
    remediation: [
      ...new Set([
        ...(failure ? [redact(failure)] : []),
        ...checks.flatMap((c) => (c.reason ? [c.reason] : [])),
        ...(!selectedReady
          ? [
              "Run explicit prepareLintProjects(root) or project_lint in OMP, resolve reported setup errors, then check again.",
            ]
          : []),
        ...(truncated
          ? [
              "Native output was truncated; address reported issues and rerun to obtain complete diagnostics.",
            ]
          : []),
      ]),
    ],
  };
}
