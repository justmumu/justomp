import { expect, test } from "bun:test";
import { withDomains } from "../../../src/dependencies/queue";
import { suppliedResponse } from "../../response";

test("cancelled waiter leaves its owner alive and independent domains run", async () => {
  const abort = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = withDomains(["queue-a"], undefined, () => held);
  const waiting = withDomains(["queue-a"], abort.signal, () => {
    return suppliedResponse(() => {
      throw new Error("must not run");
    });
  });
  abort.abort();
  await expect(waiting).rejects.toThrow();
  expect(await withDomains(["queue-b"], undefined, async () => 42)).toBe(42);
  release();
  await owner;
  expect(await withDomains(["queue-a"], undefined, async () => 7)).toBe(7);
});
