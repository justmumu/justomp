import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDomains } from "../../../src/dependencies/queue";
import { runProcess } from "../../../src/dependencies/runner";

test("runner captures bounded output and process failure independently", async () => {
  const r = await runProcess(
    process.execPath,
    [
      "-e",
      'console.log("x".repeat(200000));console.error("oops");process.exit(3)',
    ],
    { cwd: tmpdir(), limit: 2048 },
  );
  expect(r.exit_code).toBe(3);
  expect(r.stderr).toContain("oops");
  expect(r.truncated).toBe(true);
  expect(r.stdout.length).toBeLessThanOrEqual(2048);
  await expect(
    runProcess("/missing/justomp-manager", [], { cwd: tmpdir() }),
  ).rejects.toThrow();
});
test("cancellation kills the supervised process before releasing a shared domain", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const first = withDomains(["runner-test"], undefined, async () => {
    events.push("first");
    const running = runProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { cwd: tmpdir(), signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 40);
    expect((await running).cancelled).toBe(true);
    events.push("terminated");
  });
  const second = withDomains(["runner-test"], undefined, async () => {
    events.push("second");
  });
  await Promise.all([first, second]);
  expect(events).toEqual(["first", "terminated", "second"]);
});

test("cancellation also stops a grandchild that ignores SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-runner-ready-"));
  const ready = join(root, "ready");
  const controller = new AbortController();
  const grandchild = `process.on("SIGTERM",()=>{});process.stdout.write(String(process.pid)+"\\n",()=>require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid)));setInterval(()=>{},1000);`;
  const program = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
  const promise = runProcess(process.execPath, ["-e", program], {
    cwd: root,
    signal: controller.signal,
  });
  try {
    const deadline = Date.now() + 10000;
    while (!(await Bun.file(ready).exists())) {
      if (Date.now() > deadline)
        throw new Error("Grandchild did not become ready");
      await Bun.sleep(10);
    }
    const pid = Number(await readFile(ready, "utf8"));
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    const result = await promise;
    expect(result.cancelled).toBe(true);
    expect(Number(result.stdout.trim())).toBe(pid);
    const reaped = Date.now() + 2000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      if (Date.now() > reaped)
        throw new Error("Grandchild remained after cancellation");
      await Bun.sleep(10);
    }
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await promise;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
