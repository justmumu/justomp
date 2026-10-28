import { spawn } from "node:child_process";
import { DependencyError, type ProcessResult } from "./model";
export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    limit?: number;
  },
): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  const limit = options.limit ?? 128 * 1024;
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      truncated = false,
      cancelled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (buffer: Buffer<ArrayBuffer>, chunk: Buffer) => {
      if (buffer.length + chunk.length > limit) truncated = true;
      if (buffer.length >= limit) return buffer;
      return Buffer.concat([
        buffer,
        chunk.subarray(0, Math.max(0, limit - buffer.length)),
      ]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    const kill = (signal: "SIGTERM" | "SIGKILL") => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          // Windows support requires the platform smoke suite; never use a shell.
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            shell: false,
          }).on("error", () => child.kill(signal));
        } else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          child.kill(signal);
      }
    };
    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 400);
    };
    const cleanup = () => {
      if (force) clearTimeout(force);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(new DependencyError("manager-unavailable", error.message));
    });
    child.on("close", (exit_code, signal) => {
      // Also terminate descendants that closed inherited stdio before their parent.
      if (cancelled) kill("SIGKILL");
      cleanup();
      resolve({
        exit_code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated,
        cancelled,
      });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
