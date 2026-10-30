import { expect, test } from "bun:test";
import { copyArchivePayloads } from "../../fixtures/dependencies/archive-payload";

test("shared archive payloads do not share mutable bytes or registry maps", () => {
  const key = "fixture-dep-1.0.0.tgz";
  const payloads = new Map([[key, Uint8Array.from([1, 2, 3])]]);
  const first = copyArchivePayloads(payloads);
  const second = copyArchivePayloads(payloads);
  const mutable = first.get(key);
  const independent = second.get(key);
  if (!mutable || !independent) throw new Error("Missing fixture archive");
  const original = independent[0];
  mutable[0] = (mutable[0] ?? 0) ^ 0xff;
  first.delete(key);
  expect(independent[0]).toBe(original);
  expect(copyArchivePayloads(payloads).get(key)?.[0]).toBe(original);
  expect(second.has(key)).toBe(true);
});
