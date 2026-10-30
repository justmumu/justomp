import {
  type TestCase,
  TestError,
  type TestIssue,
  type TestSummary,
  unknownTests,
} from "../model";
import type { GoRunnable } from "./inventory";
/** Consume the native protocol before bounded console capture can truncate it. */
export class GoEvents {
  private decoder = new TextDecoder();
  private pending = "";
  private bytes = 0;
  private terminal = false;
  private started = false;
  private packageFailed = false;
  private buildFailed = false;
  private cases: TestCase[] = [];
  private running = new Map<string, number>();
  private completed = new Map<string, number>();
  private owners = new Map<string, GoRunnable[]>();
  constructor(
    private packageName: string,
    inventory: GoRunnable[],
  ) {
    for (const item of inventory) {
      const owners = this.owners.get(item.name) ?? [];
      owners.push(item);
      this.owners.set(item.name, owners);
    }
  }
  write(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    if (this.bytes > 64 * 1024 * 1024)
      throw new TestError("invalid-report", "Go event stream exceeds 64 MiB");
    this.pending += this.decoder.decode(chunk, { stream: true });
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (line.trim()) this.event(JSON.parse(line));
      newline = this.pending.indexOf("\n");
    }
    if (this.pending.length > 1024 * 1024)
      throw new TestError("invalid-report", "Go event exceeds 1 MiB");
  }
  private event(value: Record<string, unknown>): void {
    if (value.Package !== this.packageName)
      throw new TestError(
        "invalid-report",
        "Foreign Go package in test report",
      );
    const action = value.Action,
      name = value.Test;
    if (action === "start") {
      if (this.started)
        throw new TestError("invalid-report", "Duplicate Go package start");
      this.started = true;
      return;
    }
    if (
      typeof action !== "string" ||
      !["run", "pause", "cont", "pass", "fail", "skip", "output"].includes(
        action,
      )
    )
      throw new TestError("invalid-report", "Unknown Go event action");
    if (name !== undefined && typeof name !== "string")
      throw new TestError("invalid-report", "Invalid Go test name");
    if (typeof name === "string") {
      const top = name.split("/")[0],
        owners = this.owners.get(top ?? "");
      if (!owners)
        throw new TestError(
          "invalid-report",
          `Unselected Go test in report: ${name}`,
        );
      if (action === "run") {
        const running = (this.running.get(name) ?? 0) + 1;
        if (running + (this.completed.get(name) ?? 0) > owners.length)
          throw new TestError(
            "invalid-report",
            `Repeated Go test run: ${name}`,
          );
        this.running.set(name, running);
      }
      if (["pass", "fail", "skip"].includes(action)) {
        const completed = (this.completed.get(name) ?? 0) + 1;
        if (completed > owners.length)
          throw new TestError(
            "invalid-report",
            `Repeated Go test result: ${name}`,
          );
        this.completed.set(name, completed);
        const running = this.running.get(name) ?? 0;
        if (running > 1) this.running.set(name, running - 1);
        else this.running.delete(name);
        this.cases.push({
          name,
          ...(owners.length === 1 ? { file: owners[0]?.file } : {}),
          package: this.packageName,
          status:
            action === "pass"
              ? "passed"
              : action === "fail"
                ? "failed"
                : "skipped",
          ...(name.includes("/") ? { parent: top } : {}),
          ...(typeof value.Elapsed === "number"
            ? { duration_ms: value.Elapsed * 1000 }
            : {}),
        });
      }
    } else if (["pass", "fail", "skip"].includes(action)) {
      if (this.terminal)
        throw new TestError("invalid-report", "Repeated Go package result");
      this.terminal = true;
      this.packageFailed = action === "fail";
      this.buildFailed = typeof value.FailedBuild === "string";
    }
  }
  result(): {
    tests: TestSummary;
    errors: TestIssue[];
    executed_files: string[];
  } {
    // Identical internal/external names cannot be attributed individually from native events.
    const executed_files = [
      ...new Set(
        [...this.owners].flatMap(([name, owners]) =>
          this.completed.get(name) === owners.length
            ? owners.map((owner) => owner.file)
            : [],
        ),
      ),
    ];
    const cases = [...this.cases],
      top = cases.filter((c) => !c.parent),
      errors: TestIssue[] = [];
    if (
      !this.started ||
      !this.terminal ||
      this.pending.trim() ||
      this.running.size
    ) {
      errors.push({
        code: "incomplete-report",
        message: "Go did not complete the native test event stream",
      });
      return { tests: { ...unknownTests(), cases }, errors, executed_files };
    }
    const tests = {
      total: top.length,
      passed: top.filter((c) => c.status === "passed").length,
      failed: top.filter((c) => c.status === "failed").length,
      skipped: top.filter((c) => c.status === "skipped").length,
      cases,
    };
    if (this.buildFailed || (this.packageFailed && !tests.failed))
      errors.push({
        code: "collection-failed",
        message: "Go package compilation, TestMain or test process failed",
      });
    else if (tests.failed)
      errors.push({
        code: "test-failed",
        message: "One or more Go tests failed",
      });
    return { tests, errors, executed_files };
  }
}
