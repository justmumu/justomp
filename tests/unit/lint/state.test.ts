import { expect, spyOn, test } from "bun:test";
import * as files from "../../../src/lint/files";
import { type LintState, LintStateStore, lintWaveReady } from "../../../src/lint/state";

test("schema one migration retains each accepted exact target without discovery", async () => {
  const receipt = (ecosystem: string, tools: Record<string, string>, ready = true) => ({
    ecosystem,
    tools,
    policy_hash: "policy",
    ready,
  });
  const old = {
    schema: 1,
    projects: {
      "python:a": receipt("python", { ruff: "1.0.0" }),
      "javascript:a": receipt("javascript", {
        eslint: "9.0.0",
        prettier: "3.0.0",
      }),
      "go:a": receipt("go", { "golangci-lint": "2.0.0" }),
      "go:b": receipt("go", { "golangci-lint": "2.1.0" }, false),
    },
    python: {
      projects: ["python:a", "python:failed"],
      tools: { ruff: "1.0.0" },
      complete: false,
    },
  };
  const read = spyOn(files, "readProjectionFile").mockResolvedValue({
    text: JSON.stringify(old),
    identity: "1",
    mode: 420,
  });
  try {
    const store = await LintStateStore.load("/repo");
    expect(store.recovery).toBeUndefined();
    expect(store.state.schema).toBe(3);
    expect(store.state).toMatchObject({
      waves: {
        python: {
          projects: ["python:a", "python:failed"],
          complete: false,
          versions: { "python:failed": { ruff: "1.0.0" } },
        },
        javascript: {
          projects: ["javascript:a"],
          complete: false,
          versions: { "javascript:a": {} },
        },
        go: {
          projects: ["go:a", "go:b"],
          complete: false,
          versions: {
            "go:a": { "golangci-lint": "2.0.0" },
            "go:b": { "golangci-lint": "2.1.0" },
          },
        },
      },
    });
  } finally {
    read.mockRestore();
  }
});

test("readiness requires the whole live cohort and each accepted target", () => {
  const state: LintState = {
    schema: 3,
    projects: {
      "go:a": {
        ecosystem: "go",
        tools: { "golangci-lint": "2.0.0" },
        policy_hash: "policy",
        ready: true,
      },
      "go:b": {
        ecosystem: "go",
        tools: { "golangci-lint": "2.1.0" },
        policy_hash: "policy",
        ready: true,
      },
    },
    waves: {
      go: {
        projects: ["go:a", "go:b"],
        versions: {
          "go:a": { "golangci-lint": "2.0.0" },
          "go:b": { "golangci-lint": "2.1.0" },
        },
        complete: true,
      },
    },
  };
  expect(lintWaveReady(state, "go", ["go:a", "go:b"])).toBe(true);
  expect(lintWaveReady(state, "go", ["go:a", "go:b", "go:new"])).toBe(false);
  expect(lintWaveReady(state, "go", ["go:a"])).toBe(false);
  const receipt = state.projects["go:b"];
  if (!receipt) {
    throw new Error("Missing fixture receipt");
  }
  receipt.ready = false;
  expect(lintWaveReady(state, "go", ["go:a", "go:b"])).toBe(false);
  receipt.ready = true;
  receipt.tools = { "golangci-lint": "2.0.0" };
  expect(lintWaveReady(state, "go", ["go:a", "go:b"])).toBe(false);
});

test("incomplete schema three persists exact targets while malformed target maps recover", async () => {
  const value: LintState = {
    schema: 3,
    projects: {},
    waves: {
      javascript: {
        projects: ["javascript:a"],
        versions: { "javascript:a": { "@biomejs/biome": "2.6.3" } },
        complete: false,
      },
    },
  };
  const read = spyOn(files, "readProjectionFile").mockResolvedValue({
    text: JSON.stringify(value),
    identity: "1",
    mode: 420,
  });
  try {
    expect((await LintStateStore.load("/repo")).state).toEqual(value);
    read.mockResolvedValue({
      text: JSON.stringify({
        ...value,
        waves: { javascript: { ...value.waves.javascript, versions: {} } },
      }),
      identity: "1",
      mode: 420,
    });
    const invalid = await LintStateStore.load("/repo");
    expect(invalid.recovery).toBeDefined();
    expect(invalid.state.waves).toEqual({});
  } finally {
    read.mockRestore();
  }
});

test("schema two clears legacy JavaScript readiness and keeps other ecosystems", async () => {
  const python = {
    ecosystem: "python" as const,
    tools: { ruff: "0.14.0" },
    ready: true,
    policy_hash: "p",
  };
  const read = spyOn(files, "readProjectionFile").mockResolvedValue({
    text: JSON.stringify({
      schema: 2,
      projects: {
        "python:a": python,
        "javascript:a": {
          ecosystem: "javascript",
          tools: { eslint: "9.0.0", typescript: "7.0.2" },
          ready: true,
          policy_hash: "old",
        },
      },
      waves: {
        javascript: {
          projects: ["javascript:a"],
          versions: { "javascript:a": { eslint: "9.0.0" } },
          complete: true,
        },
      },
    }),
    identity: "1",
    mode: 420,
  });
  try {
    const store = await LintStateStore.load("/repo");
    expect(store.recovery).toBeUndefined();
    expect(store.state.projects["python:a"]).toEqual(python);
    expect(store.state.projects["javascript:a"]).toMatchObject({
      ready: false,
      tools: {},
    });
    expect(store.state.waves.javascript).toMatchObject({
      complete: false,
      versions: { "javascript:a": {} },
    });
    read.mockResolvedValue({
      text: JSON.stringify(store.state),
      identity: "2",
      mode: 420,
    });
    expect((await LintStateStore.load("/repo")).state).toEqual(store.state);
  } finally {
    read.mockRestore();
  }
});
