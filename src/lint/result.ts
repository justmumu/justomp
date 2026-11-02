import { redact } from "../dependencies/model";
import { type Project } from "../inspect/model";
import { type LintCheck, type LintFix, type LintPreparation, type LintResult } from "./model";

export interface LintOutcome {
  preparation: LintPreparation;
  checks: LintCheck[];
  policyHash: string;
  selectedReady: boolean;
  failure?: string;
  fix?: LintFix;
}
/** Compose the public result from completed stages and preparation evidence. */
export function lintResult(
  project: Pick<Project, "project_id" | "path" | "ecosystem">,
  outcome: LintOutcome,
  aborted: boolean,
): LintResult {
  const { preparation, checks, policyHash, selectedReady, failure, fix } = outcome;
  const cancelled =
    aborted || fix?.cancelled === true || fix?.status === "cancelled" || checks.some((c) => c.cancelled);
  const truncated = fix?.truncated === true || checks.some((c) => c.truncated);
  const fixComplete =
    !fix ||
    fix.status === "completed" ||
    fix.status === "unsupported" ||
    (fix.status === "not-run" && fix.reason === "no-sources");
  const complete =
    !failure &&
    fixComplete &&
    (!fix || (fix.observation_complete && !fix.errors.length)) &&
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
    ...(fix ? { fix } : {}),
    checks,
    diagnostics: checks.flatMap((c) => c.diagnostics),
    complete,
    truncated,
    cancelled,
    partial_change:
      (!preparation.complete && preparation.changes.length > 0) || (!complete && (fix?.changed_files.length ?? 0) > 0),
    incomplete_stages: [
      ...(!fixComplete ? ["fix"] : []),
      ...(fix && !fix.observation_complete ? ["observation"] : []),
      ...(!selectedReady ? ["preparation"] : []),
      ...checks.filter((c) => c.status === "not-run" || c.truncated || c.cancelled).map((c) => c.kind),
      ...(failure && checks.some((c) => c.status !== "not-run") ? ["verification"] : []),
    ],
    remediation: [
      ...new Set([
        ...(failure ? [redact(failure)] : []),
        ...(fix?.errors.map((issue) => redact(issue.message)) ?? []),
        ...checks.flatMap((c) => (c.reason ? [c.reason] : [])),
        ...(!selectedReady
          ? [
              "Run explicit prepareLintProjects(root) or project_lint in OMP, resolve reported setup errors, then check again.",
            ]
          : []),
        ...(truncated
          ? ["Native output was truncated; address reported issues and rerun to obtain complete diagnostics."]
          : []),
      ]),
    ],
  };
}
