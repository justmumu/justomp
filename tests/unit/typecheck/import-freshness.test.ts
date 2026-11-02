import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as paths from "../../../src/dependencies/paths";
import { fingerprintTypecheckAnalysisSources } from "../../../src/typecheck/freshness";
import * as scopes from "../../../src/typecheck/scope";
import { suppliedResponse } from "../../response";
import { scope, target } from "../checks/fixture";

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0).reverse()) {
    mock.mockRestore();
  }
});
test("generation freshness includes imported exclusions but omits unrelated exclusions and generated outputs", async () => {
  const selected = target("javascript");
  const root = selected.scope.cwd;
  const documents = new Map([
    [`${root}/index.ts`, "entry"],
    [`${root}/private/helper.ts`, "imported"],
    [`${root}/private/archive.ts`, "unused"],
    [`${root}/types/helper.d.ts`, "generated"],
  ]);
  mocks.push(spyOn(scopes, "collectTypecheckScope").mockResolvedValue(scope("index.ts")));
  mocks.push(spyOn(paths, "safePath").mockImplementation(async (_root, path) => path));
  mocks.push(
    spyOn(fs, "readFile").mockImplementation(((path: unknown) =>
      suppliedResponse(() => {
        const content = documents.get(String(path));
        if (content === undefined) {
          throw new Error("Unexpected source read");
        }
        return Buffer.from(content);
      })) as typeof fs.readFile),
  );
  const fingerprint = () =>
    fingerprintTypecheckAnalysisSources(
      [selected],
      [`${root}/types`],
      ["private/**"],
      [`${root}/private/helper.ts`, `${root}/types/helper.d.ts`],
    );
  const first = await fingerprint();
  documents.set(`${root}/private/archive.ts`, "changed unused archive");
  documents.set(`${root}/types/helper.d.ts`, "regenerated");
  expect(await fingerprint()).toBe(first);
  documents.set(`${root}/private/helper.ts`, "changed imported source");
  expect(await fingerprint()).not.toBe(first);
});
