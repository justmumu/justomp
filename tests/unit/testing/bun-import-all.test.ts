import { expect, test } from "bun:test";
import { importAllSources } from "../../../src/testing/javascript/bun-import-all";

test("imports exactly approved URLs with bounded concurrency and filename failures", async () => {
  let active = 0,
    maximum = 0;
  const seen: string[] = [];
  const errors = await importAllSources(
    "/project",
    ["a.ts", "b.ts", "c.ts"],
    async (url) => {
      maximum = Math.max(maximum, ++active);
      seen.push(url);
      await Promise.resolve();
      active--;
      if (url.endsWith("/b.ts")) {
        throw new Error("broken");
      }
    },
    2,
  );
  expect(maximum).toBe(2);
  expect(seen).toEqual(["file:///project/a.ts", "file:///project/b.ts", "file:///project/c.ts"]);
  expect(errors).toEqual([{ file: "b.ts", message: "broken" }]);
});
