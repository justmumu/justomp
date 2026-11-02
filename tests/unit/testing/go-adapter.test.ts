import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as executable from "../../../src/dependencies/executable";
import * as runner from "../../../src/dependencies/runner";
import * as environment from "../../../src/lint/go/environment";
import * as runtime from "../../../src/lint/runtime";
import { goTestAdapter } from "../../../src/testing/go/adapter";
import { TestError } from "../../../src/testing/model";
import { context } from "./fixture";

for (const mode of ["targeted", "continue", "cancel"] as const) {
  test(`Go adapter ${mode} respects selected packages and one interruption signal`, async () => {
    const ctx = context(mode === "targeted" ? "targeted" : "full"),
      controller = new AbortController();
    ctx.target.root = "/project";
    ctx.target.scope.owner = "/project";
    ctx.target.scope.cwd = "/project";
    ctx.signal = controller.signal;
    ctx.policy.coverage.enabled = false;
    ctx.scope.tests = ["one/a_test.go", "two/a_test.go", "three/a_test.go"];
    ctx.scope.selected = mode === "targeted" ? ["one/a_test.go"] : ctx.scope.tests;
    ctx.scope.sources = [];
    let remaining = 3000;
    ctx.remainingMs = () => (remaining -= 500);
    const commands: string[][] = [],
      signals: (AbortSignal | undefined)[] = [];
    const result = (stdout = "", exit_code: number | null = 0, cancelled = false) => ({
      stdout,
      stderr: "",
      exit_code,
      signal: null,
      truncated: false,
      cancelled,
    });
    const mocks = [
      spyOn(fs, "readFile").mockResolvedValue("module example/app\ngo 1.25\n"),
      spyOn(fs, "writeFile").mockResolvedValue(),
      spyOn(runtime, "lintManagerContext").mockResolvedValue({
        version: "1.25.6",
      } as Awaited<ReturnType<typeof runtime.lintManagerContext>>),
      spyOn(executable, "resolveExecutable").mockResolvedValue({
        command: "go",
      } as Awaited<ReturnType<typeof executable.resolveExecutable>>),
      spyOn(environment, "withGoEnvironment").mockImplementation(async (_target, _native, operation) => operation({})),
      spyOn(runner, "runProcess").mockImplementation(async (_command, args, options) => {
        commands.push(args);
        signals.push(options.signal);
        if (args[0] === "list") {
          const name = args.at(-1)?.replace("./", "");
          return result(
            JSON.stringify({
              Dir: `/project/${name}`,
              ImportPath: `example/app/${name}`,
              Name: name,
              GoFiles: ["value.go"],
              TestGoFiles: ["a_test.go"],
              ...(mode === "targeted" && name !== "one" ? { Error: { Err: "malformed unrelated package" } } : {}),
            }),
          );
        }
        if (args[0] === "run") {
          return result(
            JSON.stringify({
              constraints: [],
              runnables: ["one", "two", "three"].map((name) => ({
                file: `/project/${name}/a_test.go`,
                name: "TestValue",
              })),
            }),
          );
        }
        const name = args.at(-1)?.replace("./", "");
        const send = (event: object) =>
          options.onStdout?.(Buffer.from(JSON.stringify({ Package: `example/app/${name}`, ...event }) + "\n"));
        send({ Action: "start" });
        send({ Action: "run", Test: "TestValue" });
        if (mode === "cancel" && name === "three") {
          controller.abort(new TestError("timeout", "budget"));
          return result("", null, true);
        }
        const action = mode !== "targeted" && name === "one" ? "fail" : "pass";
        send({ Action: action, Test: "TestValue" });
        send({ Action: action });
        return result("", action === "fail" ? 1 : 0);
      }),
    ];
    try {
      const observed = await goTestAdapter.run(ctx),
        calls = commands.filter((args) => args[0] === "test");
      if (mode === "targeted") {
        expect(observed.errors).toEqual([]);
        expect(calls.map((args) => args.at(-1))).toEqual(["./one"]);
        expect(observed.tests.total).toBe(1);
      } else if (mode === "continue") {
        expect(calls.map((args) => args.at(-1))).toEqual(["./one", "./three", "./two"]);
        expect(observed.tests).toMatchObject({
          total: 3,
          failed: 1,
          passed: 2,
        });
        expect(observed.errors.map((e) => e.code)).toEqual(["test-failed"]);
        expect(calls.map((args) => args.find((arg) => arg.startsWith("-timeout=")))).toEqual([
          "-timeout=2500ms",
          "-timeout=2000ms",
          "-timeout=1500ms",
        ]);
      } else {
        expect(calls.map((args) => args.at(-1))).toEqual(["./one", "./three"]);
        expect(observed.tests.total).toBeNull();
        expect(observed.tests.cases.some((c) => c.status === "failed")).toBe(true);
        expect(observed.errors.some((e) => e.code === "cancelled")).toBe(true);
      }
      expect(calls.every((args) => !args.some((arg) => arg.startsWith("-vet=")))).toBe(true);
      expect(signals.every((signal) => signal === controller.signal)).toBe(true);
    } finally {
      for (const mock of mocks.reverse()) {
        mock.mockRestore();
      }
    }
  });
}
