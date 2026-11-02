import { open } from "node:fs/promises";

/** Persist output as it arrives, including diagnostics before a failed or interrupted run. */
export async function runCostStage(command: readonly string[], cwd: string, env: NodeJS.ProcessEnv, log: string) {
  const began = performance.now();
  const file = await open(log, "w");
  try {
    const child = Bun.spawn([...command], {
      cwd,
      env,
      stdout: file.fd,
      stderr: file.fd,
    });
    const exit_code = await child.exited;
    return { exit_code, seconds: (performance.now() - began) / 1000 };
  } finally {
    await file.close();
  }
}
