import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { bumpRepository } from "../release/bump";
import { emptyReleaseResult, failRelease, releaseResponse } from "../release/effects";
import { releaseSchemas } from "../release/schemas";
import { updateRepositoryChangelog } from "../release/service";
import { tagRepository } from "../release/tag";
import { type WithSessionRoot } from "./dependency-tools";

const operations = [
  {
    name: "repo_changelog",
    label: "Update repository changelog",
    description:
      "Update the repository-wide Unreleased changelog from committed Conventional Commits. Preserves manual changelog prose. May execute Git; does not stage, commit, tag or push.",
    parameters: releaseSchemas.changelog,
    service: (root: string, input: unknown, signal: AbortSignal) => updateRepositoryChangelog(root, input, signal),
  },
  {
    name: "repo_bump",
    label: "Prepare repository release",
    description:
      "Prepare one repository-wide patch, minor or major release from a clean working tree. Updates the version record, participating manifests, native locks and changelog. May run trusted native package managers outside generic bash protection. Leaves changes unstaged; does not commit, tag or push. Inspect changed_files and native_steps on failure or cancellation before retrying.",
    parameters: releaseSchemas.bump,
    service: (root: string, input: unknown, signal: AbortSignal) => bumpRepository(root, input, signal),
  },
  {
    name: "repo_release_tag",
    label: "Tag repository release",
    description:
      "Create a local annotated vX.Y.Z tag for the committed repository release. Requires a clean working tree on the live remote default branch at its published HEAD and checks existing local and remote tags. Executes Git and reads the remote; never pushes. Inspect created and observed_target on failure or cancellation before retrying.",
    parameters: releaseSchemas.tag,
    service: (root: string, input: unknown, signal: AbortSignal) => tagRepository(root, input, signal),
  },
];

export function registerReleaseTools(pi: ExtensionAPI, withRoot: WithSessionRoot): void {
  for (const { service, ...definition } of operations) {
    pi.registerTool({
      ...definition,
      approval: "exec",
      async execute(_callId, input, signal, _onUpdate, ctx) {
        try {
          const parsed = definition.parameters.parse(input);
          const result = await withRoot(ctx.cwd, signal, (root, activeSignal) => service(root, parsed, activeSignal));
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            isError: !result.success,
          };
        } catch (error) {
          const result = emptyReleaseResult(ctx.cwd);
          if (definition.name === "repo_release_tag") {
            result.created = false;
          }
          failRelease(result, error, signal?.aborted ?? false, false);
          const details = releaseResponse(result);
          return {
            content: [{ type: "text", text: JSON.stringify(details) }],
            details,
            isError: true,
          };
        }
      },
    });
  }
}
