import { expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lintPolicyKey } from "../../../src/config/lint/resolve";
import { loadConfig } from "../../../src/config/load";
import { withDomains } from "../../../src/dependencies/queue";
import { checkProjectLint, prepareLintProjects } from "../../../src/lint/index";
import { lintDomains } from "../../../src/lint/prepare";
import { applyProjection, planProjection } from "../../../src/lint/projection";
import { inspectLintProject, lintAdapters } from "../../../src/lint/service";
import { LintStateStore } from "../../../src/lint/state";
import { suppliedResponse } from "../../response";
import { fixture } from "./fixture";

test("queued check reports the policy actually checked after policy preparation", async () => {
  const f = await fixture();
  const previous = lintAdapters.python;
  lintAdapters.python = f.adapter;
  f.adapter.check = async () =>
    (["lint", "format"] as const).map((kind) => ({
      kind,
      status: "passed",
      tool: "ruff",
      version: "1.0.0",
      exit_code: 0,
      duration_ms: 0,
      diagnostics: [],
      truncated: false,
      cancelled: false,
    }));
  try {
    expect((await prepareLintProjects(f.root)).complete).toBe(true);
    const id = "python:a/pyproject.toml";
    const target = await inspectLintProject(f.root, id);
    const domains = lintDomains(target.root, [target]);
    const before = await loadConfig(target.root);
    const oldHash = lintPolicyKey(before.lint.python);
    let entered = () => {
      /* This supplied callback intentionally has no side effects. */
    };
    let mutate = () => {
      /* This supplied callback intentionally has no side effects. */
    };
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mutationPromise = new Promise<void>((resolve) => {
      mutate = resolve;
    });
    let preparedHash = "";
    const writer = withDomains(domains, undefined, async () => {
      entered();
      await mutationPromise;
      const path = join(target.root, ".justomp/config.json");
      const config = JSON.parse(await readFile(path, "utf8"));
      config.lint.python.ruff["line-length"] = 100;
      await writeFile(path, JSON.stringify(config));
      const policy = await loadConfig(target.root);
      await applyProjection(await planProjection(target, policy.lint));
      const store = await LintStateStore.load(target.root);
      const receipt = store.state.projects[id];
      if (!receipt) {
        throw new Error("Missing prepared fixture receipt");
      }
      preparedHash = lintPolicyKey(policy.lint.python);
      receipt.policy_hash = preparedHash;
      await store.save();
    });
    await enteredPromise;
    let checkedHash = "";
    const actualCheck = f.adapter.check;
    const checkHook = spyOn(f.adapter, "check").mockImplementation((context) => {
      return suppliedResponse(() => {
        checkedHash = lintPolicyKey(context.policy.python);
        return actualCheck(context);
      });
    });
    const checking = checkProjectLint(f.root, id);
    try {
      // Observe the real queue to place the policy write after the check's initial read.
      const queue = (
        globalThis as typeof globalThis & {
          [key: symbol]: Map<string, { waiters: unknown[] }>;
        }
      )[Symbol.for("justomp.dependencies.queue.v1")];
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = domains.some((domain) => (queue?.get(domain)?.waiters.length ?? 0) > 0);
        if (waiting) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      mutate();
      await writer;
      const result = await checking;
      expect(result.success).toBe(true);
      expect(preparedHash).not.toBe(oldHash);
      expect(checkedHash).toBe(preparedHash);
      expect(result.policy_hash).toBe(checkedHash);
    } finally {
      mutate();
      await Promise.allSettled([writer, checking]);
      checkHook.mockRestore();
    }
  } finally {
    lintAdapters.python = previous;
  }
}, 30000);
