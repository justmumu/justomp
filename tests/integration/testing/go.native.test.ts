import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { goTestAdapter } from "../../../src/testing/go/adapter";
import { nativeFixture } from "./native-fixture";

test("Go selects files in a normal package and reports tests-less owned source coverage", async () => {
  const f = await nativeFixture("go", goTestAdapter);
  try {
    await f.put("value.go", "package app\nfunc value() int { return 1 }\n");
    await f.put(
      "a_test.go",
      'package app\nimport ("os";"testing")\nfunc TestMain(m *testing.M) { os.WriteFile("main-ran",[]byte("yes"),0600); os.Exit(m.Run()) }\nfunc TestChosen(t *testing.T) { if value()!=1 { t.Fatal("wrong") } }\n',
    );
    await f.put(
      "b_test.go",
      'package app\nimport "testing"\nfunc TestOther(t *testing.T) { t.Fatal("intentional") }\n',
    );
    await f.put(
      "unused/value.go",
      "package unused\nfunc Value() int { return 2 }\n",
    );
    await f.put(
      "external_test.go",
      'package app_test\nimport "testing"\nfunc TestOther(t *testing.T) {}\n',
    );
    const full = await f.run(
      ["a_test.go", "b_test.go", "external_test.go"],
      ["value.go", "unused/value.go"],
    );
    expect(full.tests, JSON.stringify(full)).toMatchObject({
      total: 3,
      passed: 2,
      failed: 1,
    });
    expect(
      full.errors.every((e) => e.code === "test-failed"),
      JSON.stringify(full),
    ).toBe(true);
    expect(full.executed_files.sort()).toEqual([
      "a_test.go",
      "b_test.go",
      "external_test.go",
    ]);
    expect(full.coverage).toEqual({ covered: 1, total: 2 });
    const selected = await f.run(
      ["a_test.go"],
      ["value.go", "unused/value.go"],
      "targeted",
    );
    expect(selected.errors, JSON.stringify(selected)).toEqual([]);
    expect(selected.tests).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(selected.executed_files).toEqual(["a_test.go"]);
    expect(await readFile(join(f.root, "main-ran"), "utf8")).toBe("yes");
  } finally {
    await f.dispose();
  }
}, 60000);
