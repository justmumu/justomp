import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCostStage } from "../../scripts/test-cost-runner";

test("cost runner preserves actual child failure and full stdout/stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-cost-runner-"));
  try {
    const log = join(root, "output.log");
    const result = await runCostStage(
      [process.execPath, "-e", "console.log('x'.repeat(150000)); console.error('failed'); process.exit(7)"],
      root,
      process.env,
      log,
    );
    expect(result.exit_code).toBe(7);
    expect(result.seconds).toBeGreaterThan(0);
    const output = await readFile(log, "utf8");
    expect(output).toContain("x".repeat(150000));
    expect(output).toContain("failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
