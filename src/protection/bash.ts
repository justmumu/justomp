import { spawn } from "node:child_process";
import { createSandboxCommand } from "./sandbox";

export interface ProtectedBashResult {
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  truncated: boolean;
}
/** Foreground execution only: the shell and its children start inside the policy. */
export async function runProtectedBash(options: {
  command: string;
  cwd: string;
  protectedPaths: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}): Promise<ProtectedBashResult> {
  options.signal?.throwIfAborted();
  const deadline = new AbortController();
  const timeout = options.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeout) || timeout < 0)
    throw new Error("Bash timeout must be a finite non-negative number");
  const timer =
    timeout > 0 ? setTimeout(() => deadline.abort(), timeout) : undefined;
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let sandbox: Awaited<ReturnType<typeof createSandboxCommand>> | undefined;
  try {
    sandbox = await createSandboxCommand({
      command: options.command,
      cwd: options.cwd,
      protectedPaths: [...options.protectedPaths],
      signal,
      shell: "/bin/bash",
    });
    signal.throwIfAborted();
    const [executable, ...args] = sandbox.argv;
    if (!executable) throw new Error("Sandbox returned no executable");
    return await new Promise<ProtectedBashResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: sandbox?.env,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const limit = 128 * 1024;
      let output = Buffer.alloc(0);
      let truncated = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      let outputError: unknown;
      const kill = (kind: "SIGTERM" | "SIGKILL") => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, kind);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            child.kill(kind);
        }
      };
      const abort = () => {
        kill("SIGTERM");
        force ??= setTimeout(() => kill("SIGKILL"), 400);
      };
      const collect = (chunk: Buffer) => {
        if (output.length + chunk.length > limit) truncated = true;
        const remaining = Math.max(0, limit - output.length);
        if (remaining === 0) return;
        const bytes = chunk.subarray(0, remaining);
        output = Buffer.concat([output, bytes]);
        if (bytes.length && !outputError) {
          try {
            options.onOutput?.(bytes.toString("utf8"));
          } catch (error) {
            outputError = error;
            abort();
          }
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const dispose = () => {
        signal.removeEventListener("abort", abort);
        if (force) clearTimeout(force);
      };
      child.once("error", (error) => {
        dispose();
        reject(error);
      });
      // A background child can hold the pipes open after bash exits. Stop it
      // on exit; waiting for close first would deadlock until the timeout.
      child.once("exit", () => kill("SIGKILL"));
      child.once("close", (exitCode) => {
        // Foreground calls do not leave ordinary detached-stdio descendants running.
        kill("SIGKILL");
        dispose();
        if (outputError) {
          reject(outputError);
          return;
        }
        resolve({
          output: output.toString("utf8"),
          exitCode,
          cancelled: options.signal?.aborted ?? false,
          timedOut: deadline.signal.aborted,
          truncated,
        });
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    if (timer) clearTimeout(timer);
    await sandbox?.cleanup();
  }
}
