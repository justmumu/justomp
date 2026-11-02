import { expect, test } from "bun:test";
import { JAVASCRIPT_DEFAULTS } from "../../../src/config/test/javascript/defaults";
import { detectRunner } from "../../../src/testing/detect";
import { selectGoTests } from "../../../src/testing/go/inventory";
import { partitionFiles, selectTestFiles } from "../../../src/testing/selection";

test("runner evidence separates package management from runtime and rejects incompatible ownership", () => {
  expect(detectRunner("javascript", { packageManager: "bun@1.4.2" }, [])).toBe("vitest");
  expect(detectRunner("javascript", { packageManager: "bun@1.4.2", scripts: { test: "vitest run" } }, [])).toBe(
    "vitest",
  );
  expect(detectRunner("javascript", { scripts: { test: "bun test" } }, [])).toBe("bun");
  expect(detectRunner("javascript", { engines: { bun: ">=1.3" } }, [])).toBe("bun");
  expect(detectRunner("javascript", { devDependencies: { "@playwright/test": "1" } }, [])).toBe("vitest");
  expect(() => detectRunner("javascript", { scripts: { test: "jest" } }, [])).toThrow("Unsupported");
  expect(() =>
    detectRunner("javascript", { scripts: { test: "bun test" }, devDependencies: { vitest: "4" } }, []),
  ).toThrow("Conflicting");
  expect(() => detectRunner("javascript", { scripts: { test: "node scripts/run-tests.js" } }, [])).toThrow("identify");
});
test("Python orchestrator metadata alone is not an unsupported test runner", () => {
  expect(detectRunner("python", {}, ["tox.ini"])).toBe("pytest");
  expect(() => detectRunner("python", { project: { dependencies: ["nose2>=0.15"] } }, [])).toThrow("Unsupported");
});
test("test and source sets differ and exact selections never widen", () => {
  const scope = partitionFiles(
    ["src/a.ts", "src/a.d.ts", "tests/unit/a[1].test.ts", "tests/integration/a.test.ts", "src/a.test.ts"],
    JAVASCRIPT_DEFAULTS,
    "javascript",
  );
  expect(scope.tests).toEqual(["tests/unit/a[1].test.ts"]);
  expect(scope.sources).toEqual(["src/a.ts"]);
  expect(selectTestFiles(scope.tests, ["tests/unit/a[1].test.ts"])).toEqual(scope.tests);
  expect(() => selectTestFiles(scope.tests, ["tests/integration/a.test.ts"])).toThrow("not an owned unit test");
});
test("Go exact names retain package semantics and reject inseparable file selections", () => {
  const inventory = [
    { file: "a_test.go", name: "TestOne" },
    { file: "b_test.go", name: "TestTwo" },
    { file: "examples_test.go", name: "Example" },
  ];
  expect(selectGoTests(inventory, ["a_test.go"])).toEqual({
    names: ["TestOne"],
    pattern: "^(?:TestOne)$",
  });
  expect(selectGoTests(inventory, ["helper_test.go"])).toEqual({
    names: [],
    pattern: "^$",
  });
  expect(() => selectGoTests([...inventory, { file: "external_test.go", name: "TestOne" }], ["a_test.go"])).toThrow(
    "cannot distinguish",
  );
});

test("broad Python coverage patterns still exclude native non-executable file types", () => {
  const policy = {
    include: ["tests/**"],
    exclude: [],
    source: { include: ["src/**"], exclude: [] },
    coverage: { enabled: true, minimum: 70 },
  };
  expect(partitionFiles(["src/a.py", "src/a.pyi", "src/a.ipynb"], policy, "python").sources).toEqual(["src/a.py"]);
});
