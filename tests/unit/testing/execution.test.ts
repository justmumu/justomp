import { expect, spyOn, test } from "bun:test";
import { testDeadline } from "../../../src/testing/execution";

test("one monotonic deadline covers every native phase and distinguishes caller cancellation", () => {
  let now = 1000,
    fire = () => {};
  const times = spyOn(performance, "now").mockImplementation(() => now);
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fire = fn;
    return 1;
  }) as typeof setTimeout);
  const clears = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  try {
    const deadline = testDeadline(2);
    expect(deadline.remainingMs()).toBe(2000);
    now = 2500;
    expect(deadline.remainingMs()).toBe(500);
    now = 3000;
    fire();
    expect(deadline.signal.reason.code).toBe("timeout");
    deadline.dispose();
    const caller = new AbortController(),
      other = testDeadline(2, caller.signal);
    caller.abort(new Error("stop"));
    expect(other.signal.reason.code).toBe("cancelled");
    other.dispose();
    expect(clears).toHaveBeenCalled();
  } finally {
    clears.mockRestore();
    timers.mockRestore();
    times.mockRestore();
  }
});
