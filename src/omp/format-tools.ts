import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { formatIssue } from "../format/result";
import { formatProject } from "../format/service";
import { type WithSessionRoot } from "./dependency-tools";

function response<T extends object>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
    ...("success" in result && result.success === false ? { isError: true } : {}),
  };
}
export function registerFormatTools(pi: ExtensionAPI, withRoot: WithSessionRoot): void {
  const parameters = pi.zod
    .object({
      project_id: pi.zod.string().min(1).describe("Stable project_id from list_projects."),
      files: pi.zod
        .array(pi.zod.string().min(1))
        .min(1)
        .optional()
        .describe("Exact project-relative file paths. Omit to format every owned supported file."),
    })
    .strict();
  pi.registerTool({
    name: "project_format",
    label: "Format project files",
    description:
      "Format and save supported files for one project_id from list_projects. Optional files selects exact project-relative paths. Uses shared .justomp/config.json policy and prepares only required native tools; Python/Go discovery aligns latest native tools across the relevant ecosystem and waits for group readiness. Reports preparation effects separately and retains partial writes on error or cancellation.",
    parameters,
    approval: "exec",
    async execute(_callId, input, signal, onUpdate, ctx) {
      try {
        const { project_id, files } = parameters.parse(input);
        return await withRoot(ctx.cwd, signal, async (root, activeSignal) =>
          response(
            await formatProject(root, project_id, {
              ...(files === undefined ? {} : { files }),
              signal: activeSignal,
              onProgress: (progress) => onUpdate?.(response(progress)),
            }),
          ),
        );
      } catch (error) {
        return response({
          success: false,
          complete: false,
          cancelled: signal?.aborted ?? false,
          errors: [formatIssue(error, "invalid-input")],
        });
      }
    },
  });
}
