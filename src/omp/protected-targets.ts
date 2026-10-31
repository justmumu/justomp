import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
  expandPath,
  resolveToCwd,
} from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { parseSqlitePathCandidates } from "@oh-my-pi/pi-coding-agent/tools/sqlite-reader";
import { editInspect } from "@oh-my-pi/pi-natives";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import { parseArchivePathCandidates } from "@oh-my-pi/pi-utils/ar";

export class ProtectionTargetError extends Error {
  override name = "ProtectionTargetError";
}

function target(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new ProtectionTargetError(
      "Cannot determine the file mutation target",
    );
  return unwrapHashlineHeaderPath(value);
}

/** Use the same native parser as execution, including every move destination. */
export function extractProtectedToolTargets(
  toolName: string,
  input: Record<string, unknown>,
  editMode?: EditMode,
): string[] | null {
  if (!["write", "edit", "apply_patch"].includes(toolName)) return null;
  if (toolName === "write") {
    const path = target(input.path);
    // Native write may mutate a container rather than the apparent member path.
    // Include every candidate before its filesystem-dependent selection.
    return [
      ...new Set([
        path,
        ...parseArchivePathCandidates(path).map((entry) => entry.archivePath),
        ...parseSqlitePathCandidates(path).map((entry) => entry.sqlitePath),
      ]),
    ];
  }
  const mode = toolName === "apply_patch" ? "apply_patch" : editMode;
  if (!mode)
    throw new ProtectionTargetError(
      "The native edit mode is required for file protection",
    );
  const inspection = editInspect(mode, JSON.stringify(input));
  const paths = [
    ...inspection.paths,
    ...inspection.fileOps.flatMap((operation) =>
      operation.kind === "move"
        ? [operation.path, target(operation.to)]
        : [operation.path],
    ),
  ].map(target);
  if (!paths.length)
    throw new ProtectionTargetError(
      "Cannot determine every native edit target",
    );
  return [...new Set(paths)];
}

/** Keep path aliases aligned with native writes; URL mutations need their own resolver. */
export function normalizeProtectionTarget(path: string, cwd: string): string {
  const router = InternalUrlRouter.instance();
  const expanded = expandPath(target(path));
  const normalized = router.normalize(expanded);
  if (
    router.canHandle(normalized) ||
    /^@?[a-z][a-z\d+.-]*:\//i.test(normalized)
  )
    throw new ProtectionTargetError(
      `URL writes are not supported by file protection: ${path}. Use a filesystem path.`,
    );
  return resolveToCwd(normalized, cwd);
}
