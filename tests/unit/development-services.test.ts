import { afterEach, expect, spyOn, test } from "bun:test";
import { parseDevelopmentArgs } from "../../scripts/development/command";
import { invokeDevelopment, repositoryScope } from "../../scripts/development/services";
import * as config from "../../src/config/load";
import * as formatting from "../../src/format/service";
import * as lint from "../../src/lint/service";
import * as packaging from "../../src/packaging/get-structure";
import * as commitInstall from "../../src/precommit/install";
import * as pushInstall from "../../src/prepush/install";
import * as operations from "../../src/prepush/operations";
import * as prepush from "../../src/prepush/service";
import * as policy from "../../src/testing/policy";
import * as scope from "../../src/testing/scope";
import * as testing from "../../src/testing/service";
import * as targets from "../../src/testing/targets";
import * as typing from "../../src/typecheck/service";
import { target } from "./checks/fixture";

const mocks: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0).reverse()) {
    mock.mockRestore();
  }
});
function keep<T extends { mockRestore(): void }>(mock: T): T {
  mocks.push(mock);
  return mock;
}
const signal = new AbortController().signal;
const call = (action: string) => invokeDevelopment("/repo", parseDevelopmentArgs([action]), signal);

test("actions delegate to native services with repository identity and shared preparation", async () => {
  const selected = target("javascript");
  keep(spyOn(lint, "inspectLintProject").mockResolvedValue(selected));
  const preparation = {} as Awaited<ReturnType<typeof lint.prepareLintProjects>>;
  keep(spyOn(lint, "prepareLintProjects").mockResolvedValue(preparation));
  const check = keep(
    spyOn(lint, "checkLintTarget").mockResolvedValue({} as Awaited<ReturnType<typeof lint.checkLintTarget>>),
  );
  const fix = keep(
    spyOn(lint, "fixLintTarget").mockResolvedValue({} as Awaited<ReturnType<typeof lint.fixLintTarget>>),
  );
  await call("lint");
  await call("lint-fix");
  expect(check).toHaveBeenCalledWith(selected, signal, preparation);
  expect(fix).toHaveBeenCalledWith(selected, signal, preparation);
  const format = keep(
    spyOn(formatting, "formatProject").mockResolvedValue({} as Awaited<ReturnType<typeof formatting.formatProject>>),
  );
  const typecheck = keep(
    spyOn(typing, "typecheckProject").mockResolvedValue({} as Awaited<ReturnType<typeof typing.typecheckProject>>),
  );
  const unit = keep(
    spyOn(testing, "testProject").mockResolvedValue({} as Awaited<ReturnType<typeof testing.testProject>>),
  );
  const integration = keep(
    spyOn(testing, "integrationTestProject").mockResolvedValue(
      {} as Awaited<ReturnType<typeof testing.integrationTestProject>>,
    ),
  );
  const push = keep(
    spyOn(prepush, "runPrepush").mockResolvedValue({} as Awaited<ReturnType<typeof prepush.runPrepush>>),
  );
  for (const action of ["format", "typecheck", "test", "integration", "check"]) {
    await call(action);
  }
  expect(format).toHaveBeenCalledWith("/repo", "javascript:package.json", { signal });
  expect(typecheck).toHaveBeenCalledWith("/repo", "javascript:package.json", signal);
  for (const native of [unit, integration]) {
    expect(native).toHaveBeenCalledWith(
      "/repo",
      { project_id: "javascript:package.json", timeout_seconds: 300 },
      signal,
    );
  }
  expect(push).toHaveBeenCalledWith("/repo", signal);
});
test("setup preserves preparation failure and partial installation while remaining idempotent", async () => {
  const prepare = keep(
    spyOn(operations, "createPushOperations").mockReturnValue({
      prepare: () => Promise.resolve({ success: true, complete: true, stage: "preparation", effects: [], details: {} }),
      run: () => {
        throw new Error("not invoked");
      },
    }),
  );
  const first = keep(spyOn(commitInstall, "installPrecommit").mockResolvedValue({ status: "ready", message: "ready" }));
  const second = keep(
    spyOn(pushInstall, "installPrepush").mockResolvedValue({ status: "conflict", message: "user hook changed" }),
  );
  expect(await call("setup")).toMatchObject({
    success: false,
    complete: true,
    hooks: [
      { stage: "pre-commit", installation: { status: "ready" } },
      { stage: "pre-push", installation: { status: "conflict" } },
    ],
  });
  second.mockResolvedValue({ status: "installed", message: "installed" });
  expect(await call("setup")).toMatchObject({ success: true, complete: true });
  second.mockRejectedValue(new Error("disk failed"));
  expect(await call("setup")).toMatchObject({ success: false, complete: false, hooks: [{ stage: "pre-commit" }] });
  prepare.mockReturnValue({
    prepare: () => Promise.resolve({ success: false, complete: false, stage: "preparation", effects: [], details: {} }),
    run: () => {
      throw new Error("not invoked");
    },
  });
  expect(await call("setup")).toMatchObject({ success: false, complete: false, hooks: [] });
  expect(first).toHaveBeenCalledTimes(3);
});
test("root validation rejects wrong identity and returns the canonical owned inventory", async () => {
  const selected = target("javascript");
  selected.project.project_id = "javascript:package.json";
  selected.project.path = ".";
  const structure = { ...selected.structure, complete: true };
  keep(
    spyOn(packaging, "getPackagingStructure").mockResolvedValue({ structure } as Awaited<
      ReturnType<typeof packaging.getPackagingStructure>
    >),
  );
  keep(
    spyOn(targets, "resolveTestTarget").mockResolvedValue(
      selected as Awaited<ReturnType<typeof targets.resolveTestTarget>>,
    ),
  );
  keep(spyOn(config, "loadConfig").mockResolvedValue({} as config.LoadedConfig));
  keep(spyOn(policy, "suitePolicies").mockReturnValue({} as ReturnType<typeof policy.suitePolicies>));
  const owned = { sources: ["src/index.ts"], tests: [], selected: [], fingerprint: "owned" };
  keep(spyOn(scope, "collectTestScope").mockResolvedValue(owned));
  expect(await repositoryScope("/repo", "unit", signal)).toBe(owned);
  selected.project.path = "nested";
  await expect(repositoryScope("/repo", "unit", signal)).rejects.toThrow("root JavaScript");
  structure.complete = false;
  await expect(repositoryScope("/repo", "unit", signal)).rejects.toThrow("root JavaScript");
});
