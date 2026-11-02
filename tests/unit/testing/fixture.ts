import { type TestRunContext } from "../../../src/testing/adapters";
export function context(mode: "full" | "targeted" = "full"): TestRunContext {
  return {
    tools: {},
    signal: new AbortController().signal,
    target: { scope: { cwd: "/project", env: { PATH: "/bin" } } },
    mode,
    scope: {
      selected: ["tests/test-a.py"],
      tests: ["tests/test-a.py"],
      sources: ["src/ns/never.py"],
      fingerprint: "",
    },
    artifacts: "/reports",
    remainingMs: () => 12345,
    policy: {
      include: [],
      exclude: [],
      source: { include: [], exclude: [] },
      coverage: { enabled: true, minimum: 70 },
    },
  } as unknown as TestRunContext;
}

/** Execute supplied collaborators synchronously while preserving async rejection semantics. */
export function suppliedResponse<T>(read: () => T): Promise<T> {
  return new Promise((resolve) => resolve(read()));
}
