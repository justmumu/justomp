import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { commitRepository } from "../commit/service";
import { type WithSessionRoot } from "./dependency-tools";

export function registerCommitTools(pi: ExtensionAPI, withRoot: WithSessionRoot): void {
  const parameters = pi.zod
    .object({
      message: pi.zod
        .string()
        .min(1)
        .describe("Full Conventional Commit message. Header defaults to at most 72 characters."),
    })
    .strict();
  pi.registerTool({
    name: "repo_commit",
    label: "Commit repository",
    description:
      "Validate the message and commit the existing Git index through the repository's native hooks. Pre-commit fixes/formats whole affected projects and stages observed effects (including previous unstaged content in those files). Runs trusted Git/repository hooks outside generic bash protection. No push, amend or hook bypass. Inspect committed/hash on cancellation before retrying.",
    parameters,
    approval: "exec",
    async execute(_callId, input, signal, _onUpdate, ctx) {
      try {
        const { message } = parameters.parse(input);
        const result = await withRoot(ctx.cwd, signal, (root, activeSignal) =>
          commitRepository(root, message, activeSignal),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
          isError: !result.success,
        };
      } catch (error) {
        const result = {
          success: false,
          committed: false,
          errors: [error instanceof Error ? error.message : String(error)],
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
          isError: true,
        };
      }
    },
  });
}
