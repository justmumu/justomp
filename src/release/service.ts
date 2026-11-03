import { join } from "node:path";
import { readProjectionFile } from "../lint/files";
import { renderReleaseNotes, updateUnreleased } from "./changelog";
import { assertHead, withReleaseRepository } from "./coordination";
import { emptyReleaseResult, failRelease, releaseResponse } from "./effects";
import { captureHistory } from "./history";
import { type ReleaseResult } from "./model";
import { publishReleaseFile } from "./publication";
import { releaseSchemas } from "./schemas";
export async function updateRepositoryChangelog(
  cwd: string,
  input: unknown = {},
  signal = new AbortController().signal,
): Promise<ReleaseResult> {
  const result = emptyReleaseResult(cwd);
  let started = false;
  try {
    releaseSchemas.changelog.parse(input);
    await withReleaseRepository(cwd, signal, async (repo) => {
      result.root = repo.git.root;
      result.participants = repo.participants;
      const history = await captureHistory(result.root, repo.config.release, signal);
      const notes = await renderReleaseNotes(history.commits);
      const text = updateUnreleased(repo.changelog.text, notes.body);
      Object.assign(result, {
        base_commit: history.base,
        end_commit: history.end,
        included_commits: notes.included,
        skipped_commits: notes.skipped,
        changelog_file: repo.config.release.changelog_file,
      });
      await assertHead(result.root, history.end, signal);
      started = true;
      try {
        await publishReleaseFile(result.root, repo.config.release.changelog_file, repo.changelog, text, signal);
      } finally {
        const after = await readProjectionFile(result.root, join(result.root, repo.config.release.changelog_file));
        result.changed_files = after.text === repo.changelog.text ? [] : [repo.config.release.changelog_file];
      }
      result.success = true;
      result.status = "success";
    });
  } catch (error) {
    failRelease(result, error, signal.aborted, started);
  }
  return releaseResponse(result);
}
