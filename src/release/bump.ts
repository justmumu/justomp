import { gitText } from "../precommit/git";
import {
  applyReleaseMetadata,
  executeReleaseSteps,
  prepareReleaseAdapters,
  verifyReleaseMetadata,
} from "./adapters/service";
import { addRelease, renderReleaseNotes } from "./changelog";
import { assertClean, assertHead, withReleaseRepository } from "./coordination";
import {
  captureReleaseEffects,
  emptyReleaseResult,
  failRelease,
  observeReleaseChanges,
  releaseResponse,
} from "./effects";
import { captureHistory } from "./history";
import { ReleaseError, type ReleaseResult } from "./model";
import { gatherNativeReferenceEvidence } from "./native-evidence";
import { publishReleaseFile } from "./publication";
import { releaseSchemas } from "./schemas";
import { nextVersion, resolveCommonVersion } from "./version";
export async function bumpRepository(
  cwd: string,
  input: unknown,
  signal = new AbortController().signal,
): Promise<ReleaseResult> {
  const result = emptyReleaseResult(cwd);
  let started = false;
  const date = new Date().toISOString().slice(0, 10);
  try {
    const { increment } = releaseSchemas.bump.parse(input);
    await withReleaseRepository(cwd, signal, async (repo) => {
      result.root = repo.git.root;
      result.participants = repo.participants;
      await assertClean(result.root, signal);
      const history = await captureHistory(result.root, repo.config.release, signal);
      const previous = resolveCommonVersion(
        repo.participants,
        repo.version.text,
        history.tag?.slice(1) ?? null,
        repo.config.release.version_file,
      );
      const target = nextVersion(previous, increment);
      const notes = await renderReleaseNotes(history.commits);
      const changelog = addRelease(repo.changelog.text, target, date, notes.body);
      Object.assign(result, {
        previous_version: previous,
        target_version: target,
        base_commit: history.base,
        end_commit: history.end,
        included_commits: notes.included,
        skipped_commits: notes.skipped,
        changelog_file: repo.config.release.changelog_file,
        manual_unreleased: changelog.manualUnreleased,
      });
      const evidence = await gatherNativeReferenceEvidence(repo, signal);
      const plan = await prepareReleaseAdapters(repo, target, evidence, signal);
      const before = await captureReleaseEffects(plan);
      const index = await gitText(result.root, ["ls-files", "--stage", "-z"], signal);
      await assertHead(result.root, history.end, signal);
      await assertClean(result.root, signal);
      started = true;
      try {
        await applyReleaseMetadata(plan, signal);
        await executeReleaseSteps(plan, (step) => result.native_steps.push(step), signal);
        await verifyReleaseMetadata(plan, signal);
        await assertHead(result.root, history.end, signal);
        if (index !== (await gitText(result.root, ["ls-files", "--stage", "-z"], signal))) {
          throw new ReleaseError("index-changed", "Git index changed during release preparation");
        }
        await publishReleaseFile(result.root, repo.config.release.version_file, repo.version, `${target}\n`, signal);
        await publishReleaseFile(
          result.root,
          repo.config.release.changelog_file,
          repo.changelog,
          changelog.text,
          signal,
        );
        result.success = true;
        result.status = "success";
      } finally {
        await observeReleaseChanges(result.root, result, before);
        result.affected_projects = repo.manifests
          .filter(
            (manifest) =>
              result.changed_files.includes(manifest.project.manifest) ||
              plan.owners.some(
                (owner) =>
                  owner.context.project.managerRoot === manifest.project.managerRoot &&
                  owner.context.project.ecosystem === manifest.project.ecosystem,
              ),
          )
          .map((manifest) => manifest.project.project_id);
      }
    });
  } catch (error) {
    failRelease(result, error, signal.aborted || result.native_steps.some((step) => step.result.cancelled), started);
  }
  return releaseResponse(result);
}
