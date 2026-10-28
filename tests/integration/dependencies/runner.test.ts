import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
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
test("cancelled waiter leaves its owner alive and independent domains run", async () => {
  const abort = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = withDomains(["queue-a"], undefined, () => held);
  const waiting = withDomains(["queue-a"], abort.signal, async () => {
    throw new Error("must not run");
  });
  abort.abort();
  await expect(waiting).rejects.toThrow();
  expect(await withDomains(["queue-b"], undefined, async () => 42)).toBe(42);
  release();
  await owner;
  expect(await withDomains(["queue-a"], undefined, async () => 7)).toBe(7);
});

test("cancellation also stops a grandchild that ignores SIGTERM", async () => {
  const controller = new AbortController();
  const program = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
  const promise = runProcess(process.execPath, ["-e", program], {
    cwd: tmpdir(),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 150);
  const result = await promise;
  expect(result.cancelled).toBe(true);
  const pid = Number(result.stdout.trim());
  expect(pid).toBeGreaterThan(0);
  await Bun.sleep(30);
  expect(() => process.kill(pid, 0)).toThrow();
});
