import { resolveExecutable, validatePnpmNativeScope } from "../dependencies/executable";
import { type AdapterContext, type NativeStep } from "../dependencies/model";
import { safePath } from "../dependencies/paths";
import { runProcess } from "../dependencies/runner";
import { type LintTarget } from "./targets";

/** Native dependency context for a caller that already owns target.scope.domains. */
export async function lintManagerContext(target: LintTarget, signal: AbortSignal): Promise<AdapterContext> {
  const executable = await resolveExecutable(target.root, target.project, signal, target.scope);
  if (executable.manager === "pnpm") {
    await validatePnpmNativeScope(target.root, target.scope, executable.command, signal);
  }
  return {
    root: target.root,
    project: target.project,
    structure: target.structure,
    cwd: executable.cwd,
    owner: executable.owner,
    manager: executable.manager,
    version: executable.version,
    signal,
    run: async (step: NativeStep) =>
      runProcess(executable.command, step.args, {
        cwd: await safePath(target.root, step.cwd ?? executable.cwd),
        env: { ...executable.env, ...step.env },
        signal,
      }),
  };
}
