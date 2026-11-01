import { resolve } from "node:path";
import { lintPolicyKey } from "../config/lint/resolve";
import { type LoadedConfig, loadConfig } from "../config/load";
import { within } from "../dependencies/paths";
import { withDomains } from "../dependencies/queue";
import { isDiscoveryInput } from "../inspect/exclusions";
import type { LintCheckContext } from "../lint/adapters/types";
import { lintDomains, prepareLint } from "../lint/prepare";
import { planProjection } from "../lint/projection";
import { lintAdapters } from "../lint/service";
import { LintStateStore, lintWaveReady } from "../lint/state";
import { type LintTarget, resolveLintTarget } from "../lint/targets";
import { getPackagingStructure } from "../packaging/get-structure";
import { formatGo } from "./engines/go";
import { formatPrettier, prettierVersion } from "./engines/prettier";
import { assertFormatProcess } from "./engines/process";
import { formatPython } from "./engines/python";
import { publishFormatFile, readFormatFile } from "./files";
import { FormatError } from "./model";
import { type FormatResult, finishFormat, formatIssue } from "./result";
import { collectFormatScope } from "./scope";
import { formatterFor, selectFormatFiles } from "./selection";

export interface FormatProgress {
  stage: "selection" | "preparation" | "waiting" | "formatting" | "refresh";
  completed: number;
  total: number;
  current_path?: string;
}
export interface FormatOptions {
  files?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (progress: FormatProgress) => void;
}
function selectedFormatter(path: string, target: LintTarget) {
  const formatter = formatterFor(path, target.project.ecosystem);
  if (!formatter)
    throw new FormatError("invalid-files", `Unsupported format file: ${path}`);
  return formatter;
}
function ownership(target: LintTarget): string {
  return JSON.stringify([
    target.root,
    target.scope.cwd,
    target.scope.owner,
    target.scope.manager,
    target.project.manifest,
    target.project.ecosystem,
    target.project.workspace,
    lintDomains(target.root, [target]),
    target.structure.projects
      .filter((project) =>
        within(target.scope.cwd, resolve(target.root, project.path)),
      )
      .map((project) => [project.project_id, project.path, project.manifest])
      .sort(),
  ]);
}
async function liveTarget(
  root: string,
  id: string,
  signal: AbortSignal,
): Promise<LintTarget> {
  const { structure } = await getPackagingStructure(root, {
    signal,
    refresh: true,
    publish: false,
  });
  return resolveLintTarget(structure, id);
}
async function nativeContext(
  target: LintTarget,
  policy: LoadedConfig,
  signal: AbortSignal,
): Promise<LintCheckContext> {
  const store = await LintStateStore.load(target.root);
  const receipt = store.state.projects[target.project.project_id];
  if (
    store.recovery ||
    !receipt?.ready ||
    receipt.policy_hash !== lintPolicyKey(policy.lint[target.project.ecosystem])
  )
    throw new FormatError(
      "not-ready",
      "Native format preparation is not current",
    );
  if (
    !lintWaveReady(
      store.state,
      target.project.ecosystem,
      target.structure.projects
        .filter((p) => p.ecosystem === target.project.ecosystem)
        .map((p) => p.project_id),
    )
  )
    throw new FormatError(
      `incomplete-${target.project.ecosystem}-wave`,
      "Lint version alignment wave is incomplete",
    );
  const context: LintCheckContext = {
    target,
    policy: policy.lint,
    versions: receipt.tools,
    signal,
    projection: await planProjection(target, policy.lint, receipt.tools),
  };
  if (
    !context.projection.current ||
    !(await lintAdapters[target.project.ecosystem].verify(context))
  )
    throw new FormatError(
      "not-ready",
      "Native format environment changed after preparation",
    );
  return context;
}
/** Writes owned files serially, retaining observed partial effects on failure or cancellation. */
export async function formatProject(
  root: string,
  projectId: string,
  options: FormatOptions = {},
): Promise<FormatResult> {
  const started = performance.now();
  const signal = options.signal ?? new AbortController().signal;
  const result: FormatResult = {
    project_id: projectId,
    relative_path: null,
    selection: options.files === undefined ? "all" : "explicit",
    ...(Array.isArray(options.files)
      ? { requested_files: [...options.files] }
      : {}),
    success: false,
    complete: false,
    cancelled: false,
    files: [],
    formatters: [],
    preparation_changes: [],
    affected_projects: [],
    errors: [],
    duration_ms: 0,
    summary: "incomplete",
  };
  let completed = 0;
  function progress(stage: FormatProgress["stage"], current_path?: string) {
    try {
      options.onProgress?.({
        stage,
        completed,
        total: result.files.length,
        ...(current_path ? { current_path } : {}),
      });
    } catch {
      /* Reporting cannot interrupt writes or cleanup. */
    }
  }
  try {
    signal.throwIfAborted();
    if (typeof projectId !== "string" || !projectId.trim())
      throw new FormatError("invalid-input", "project_id is required");
    if (
      options.files !== undefined &&
      (!Array.isArray(options.files) ||
        options.files.some((file) => typeof file !== "string"))
    )
      throw new FormatError(
        "invalid-files",
        "files must be a non-empty list of exact project-relative paths",
      );
    progress("selection");
    const initial = await liveTarget(root, projectId, signal);
    result.relative_path = initial.project.path;
    const policy = await loadConfig(initial.root, { signal });
    const selected = selectFormatFiles(
      await collectFormatScope(
        initial,
        policy.format,
        policy.lint,
        options.files,
      ),
      options.files,
    );
    const identity = ownership(initial);
    const selectResults = (target: LintTarget, paths: string[]) =>
      paths.map((path) => ({
        path,
        engine: selectedFormatter(path, target).engine,
        status: "not-run" as const,
      }));
    result.files = selectResults(initial, selected);
    // Explicit inputs are validated as a whole before any config or native setup writes.
    const flushed = await loadConfig(initial.root, { signal, flush: true });
    if (flushed.wrote) {
      result.preparation_changes.push({
        project_id: projectId,
        path: ".justomp/config.json",
        kind: "updated",
      });
      result.affected_projects.push(
        ...initial.structure.projects.map((project) => project.project_id),
      );
    }
    const needsNative = selected.some(
      (path) =>
        formatterFor(path, initial.project.ecosystem)?.engine !== "prettier",
    );
    if (needsNative) {
      progress("preparation");
      const report = await prepareLint(
        initial.root,
        lintAdapters,
        signal,
        () => progress("preparation"),
        [initial.project.ecosystem],
      );
      result.preparation_changes.push(...report.changes);
      result.affected_projects.push(...report.affected_projects);
      result.errors.push(...report.errors);
      if (report.changes.some((change) => isDiscoveryInput(change.path))) {
        progress("refresh");
        try {
          await getPackagingStructure(initial.root, { refresh: true });
        } catch (error) {
          result.errors.push({ ...formatIssue(error), code: "refresh-failed" });
        }
      }
      if (!report.complete || result.errors.length) {
        if (!report.complete && !report.errors.length)
          result.errors.push({
            code: "preparation-incomplete",
            message: "Native format preparation did not complete",
          });
        return finishFormat(
          result,
          started,
          signal.aborted || report.cancelled,
        );
      }
    }
    progress("waiting");
    await withDomains(
      lintDomains(initial.root, [initial]),
      signal,
      async () => {
        signal.throwIfAborted();
        const target = await liveTarget(initial.root, projectId, signal);
        if (ownership(target) !== identity)
          throw new FormatError(
            "ownership-changed",
            "Project ownership changed while format was waiting",
          );
        const currentPolicy = await loadConfig(target.root, { signal });
        const current = selectFormatFiles(
          await collectFormatScope(
            target,
            currentPolicy.format,
            currentPolicy.lint,
            options.files,
          ),
          options.files,
        );
        result.files = selectResults(target, current);
        completed = 0;
        const currentNative = current.some(
          (path) =>
            formatterFor(path, target.project.ecosystem)?.engine !== "prettier",
        );
        const context = currentNative
          ? await nativeContext(target, currentPolicy, signal)
          : undefined;
        let metadataChanged = false;
        try {
          for (const file of result.files) {
            signal.throwIfAborted();
            progress("formatting", file.path);
            try {
              const path = resolve(target.scope.cwd, file.path);
              // Check from canonical inspection root, so project-directory aliases are rejected too.
              const before = await readFormatFile(target.root, path);
              const formatter = selectedFormatter(file.path, target);
              const version =
                formatter.engine === "prettier"
                  ? prettierVersion
                  : context?.versions[
                      formatter.engine === "ruff" ? "ruff" : "golangci-lint"
                    ];
              if (!version)
                throw new FormatError(
                  "not-ready",
                  "Prepared formatter version is missing",
                );
              signal.throwIfAborted();
              if (
                !result.formatters.some(
                  (entry) => entry.engine === formatter.engine,
                )
              )
                result.formatters.push({ engine: formatter.engine, version });
              if (formatter.engine === "prettier") {
                const text = await formatPrettier(
                  before.text,
                  formatter.parser,
                  currentPolicy.format.prettier,
                );
                signal.throwIfAborted();
                if (text !== before.text)
                  await publishFormatFile(
                    target.root,
                    path,
                    before,
                    text,
                    signal,
                  );
                file.status = text === before.text ? "unchanged" : "changed";
              } else {
                if (!context)
                  throw new FormatError(
                    "not-ready",
                    "Native format context is missing",
                  );
                try {
                  const process = await (formatter.engine === "ruff"
                    ? formatPython
                    : formatGo)(context, [file.path]);
                  assertFormatProcess(process, formatter.engine);
                  signal.throwIfAborted();
                } finally {
                  const after = await readFormatFile(target.root, path);
                  file.changed = before.text !== after.text;
                }
                file.status = file.changed ? "changed" : "unchanged";
                delete file.changed;
              }
            } catch (error) {
              file.status = "failed";
              file.error = {
                ...formatIssue(
                  error,
                  signal.aborted ? "cancelled" : "format-failed",
                ),
                path: file.path,
              };
              result.errors.push(file.error);
              break;
            } finally {
              completed++;
              if (
                (file.status === "changed" || file.changed) &&
                isDiscoveryInput(file.path)
              )
                metadataChanged = true;
            }
          }
        } finally {
          if (metadataChanged) {
            progress("refresh");
            try {
              await getPackagingStructure(target.root, { refresh: true });
            } catch (error) {
              result.errors.push({
                ...formatIssue(error),
                code: "refresh-failed",
              });
            }
          }
        }
      },
    );
  } catch (error) {
    result.errors.push(
      formatIssue(error, signal.aborted ? "cancelled" : "format-failed"),
    );
  }
  return finishFormat(result, started, signal.aborted);
}
