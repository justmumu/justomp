import { expect, test } from "bun:test";
import { type GateCheckStage, type GateStage } from "../../../src/precommit/model";
import { type GatePorts, runGate } from "../../../src/precommit/pipeline";
import { suppliedResponse } from "../../response";

function successfulPorts(calls: string[]): GatePorts {
  return {
    run: (stage, id) => {
      return suppliedResponse(() => {
        calls.push(`${stage}:${id}`);
        return {
          stage,
          success: true,
          complete: true,
          effects: [],
          affected_projects: [],
          details: {},
        };
      });
    },
    observe: () => {
      return Promise.resolve();
    },
    verify: () => {
      return Promise.resolve();
    },
    stage: () => {
      return suppliedResponse(() => {
        calls.push("stage");
        return [];
      });
    },
    whitespace: async () => true,
    dependencyKey: (id) => (id.startsWith("shared") ? "workspace" : id),
  };
}

test("shared dependency scopes run once while distinct scopes remain separate", async () => {
  const calls: string[] = [];
  const result = await runGate(
    ["shared-a", "shared-b", "separate-a", "separate-b"],
    successfulPorts(calls),
    new AbortController().signal,
  );
  expect(result.success).toBe(true);
  expect(calls.filter((call) => call.startsWith("dependency:"))).toEqual([
    "dependency:shared-a",
    "dependency:separate-a",
    "dependency:separate-b",
  ]);
  expect(calls.filter((call) => call.startsWith("format:"))).toHaveLength(4);
});

test("dependency failure is reported without repair or rerun", async () => {
  const calls: string[] = [];
  const ports = successfulPorts(calls);
  const run = ports.run;
  ports.run = async (stage, id) => ({
    ...(await run(stage, id)),
    success: stage !== "dependency",
  });
  const result = await runGate(["api"], ports, new AbortController().signal);
  expect(result.success).toBe(false);
  expect(result.complete).toBe(true);
  expect(calls).toEqual(["fix:api", "format:api", "lint:api", "typecheck:api", "dependency:api", "stage"]);
});

test("cancellation after an awaited stage records effects but does not stage", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const ports = successfulPorts(calls);
  const run = ports.run;
  ports.run = async (stage, id) => {
    const result = await run(stage, id);
    controller.abort();
    return { ...result, effects: ["a.ts"] };
  };
  const result = await runGate(["api"], ports, controller.signal);
  expect(result.cancelled).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.changed_files).toEqual(["a.ts"]);
  expect(calls).toEqual(["fix:api"]);
});

test("fix and format precede checks; completed failure still stages known effects", async () => {
  const calls: string[] = [];
  const result = await runGate(
    ["api"],
    {
      run: (stage, id): Promise<GateStage> => {
        return suppliedResponse(() => {
          calls.push(stage);
          return {
            stage,
            project_id: id,
            success: stage !== "typecheck",
            complete: true,
            effects: stage === "format" ? ["api/a.ts"] : [],
            affected_projects: [],
            details: {},
          };
        });
      },
      observe: () => {
        return Promise.resolve();
      },
      verify: () => {
        return Promise.resolve();
      },
      stage: () => {
        return suppliedResponse(() => {
          calls.push("stage");
          return ["api/a.ts"];
        });
      },
      whitespace: () => {
        return suppliedResponse(() => {
          calls.push("whitespace");
          return true;
        });
      },
      dependencyKey: (id) => id,
    },
    new AbortController().signal,
  );
  expect(calls).toEqual(["fix", "format", "lint", "typecheck", "stage", "whitespace"]);
  expect(result.success).toBe(false);
  expect(result.complete).toBe(true);
  expect(result.staged_files).toEqual(["api/a.ts"]);
});
test("incomplete observation never stages; empty selection only checks whitespace", async () => {
  let stages = 0;
  const ports = {
    run: async (stage: GateCheckStage): Promise<GateStage> => ({
      stage,
      success: false,
      complete: false,
      effects: [],
      affected_projects: [],
      details: {},
    }),
    observe: () => {
      return Promise.resolve();
    },
    verify: () => {
      return Promise.resolve();
    },
    stage: () => {
      return suppliedResponse(() => {
        stages++;
        return [];
      });
    },
    whitespace: async () => true,
    dependencyKey: (id: string) => id,
  };
  expect((await runGate(["api"], ports, new AbortController().signal)).complete).toBe(false);
  expect(stages).toBe(0);
  expect((await runGate([], ports, new AbortController().signal)).success).toBe(true);
});
