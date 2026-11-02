import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackagingStructure } from "../../../src/packaging/get-structure";
import { collectTypecheckScope } from "../../../src/typecheck/scope";
import { resolveTypecheckTarget } from "../../../src/typecheck/targets";
import { fixture } from "./fixture";

test("compiler scope includes first-party tests and generated Go sources but excludes children and dependencies", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "go/vendor"), { recursive: true });
  await mkdir(join(f.root, "go/child"), { recursive: true });
  await writeFile(join(f.root, "go/go.mod"), "module example.test/main\ngo 1.25\n");
  await writeFile(join(f.root, "go/main_test.go"), "package main");
  await writeFile(join(f.root, "go/generated.go"), "// Code generated fixture DO NOT EDIT.\npackage main");
  await writeFile(join(f.root, "go/vendor/no.go"), "package vendor");
  await writeFile(join(f.root, "go/child/go.mod"), "module example.test/child\ngo 1.25\n");
  await writeFile(join(f.root, "go/child/no.go"), "package child");
  const { structure } = await getPackagingStructure(f.root, { publish: false });
  const target = await resolveTypecheckTarget(structure, "go:go/go.mod");
  expect((await collectTypecheckScope(target)).files).toEqual(["generated.go", "main_test.go"]);
});
