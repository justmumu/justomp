import { expect, test } from "bun:test";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withReadyTypecheckTarget } from "../../../src/typecheck/coordinator";
import { prepareTypecheck } from "../../../src/typecheck/prepare";
import { fixture } from "./fixture";

test("new discovery supersedes a failed wave and unchanged retries retain its exact target", async () => {
  const f = await fixture();
  const run = () =>
    prepareTypecheck(
      f.root,
      { python: f.adapter },
      new AbortController().signal,
    );
  expect((await run()).complete).toBe(true);
  await f.add("b");
  f.latest("2.0.0");
  f.fail("b");
  expect((await run()).complete).toBe(false);
  await f.add("c");
  f.latest("3.0.0");
  expect((await run()).complete).toBe(false);
  expect(f.counts().resolves).toBe(3);
  const state = JSON.parse(
    await readFile(join(f.root, ".justomp/typecheck_state.json"), "utf8"),
  );
  expect(state.waves.python.pending).toEqual([]);
  expect(state.waves.python.tools).toEqual({ pyright: "3.0.0" });
  await expect(
    withReadyTypecheckTarget(
      f.root,
      "python:a/pyproject.toml",
      { python: f.adapter },
      async () => true,
    ),
  ).rejects.toThrow("wave");
  f.fail("b");
  expect((await run()).complete).toBe(false);
  expect(f.counts().resolves).toBe(3);
  await expect(
    withReadyTypecheckTarget(
      f.root,
      "python:a/pyproject.toml",
      { python: f.adapter },
      async () => true,
    ),
  ).rejects.toThrow("wave");
  f.fail("");
  f.latest("4.0.0");
  expect((await run()).complete).toBe(true);
  expect(f.counts().resolves).toBe(3);
  for (const name of ["a", "b", "c"])
    expect(
      JSON.parse(await readFile(join(f.root, name, "installed.json"), "utf8")),
    ).toEqual({ pyright: "3.0.0" });
  expect((await run()).complete).toBe(true);
  expect(f.counts().resolves).toBe(3);
  await rm(join(f.root, "c"), { recursive: true });
  expect((await run()).complete).toBe(true);
  expect(f.counts().resolves).toBe(3);
});

test("deleted failed member no longer blocks a wave and old project IDs never mutate", async () => {
  const f = await fixture();
  const run = () =>
    prepareTypecheck(
      f.root,
      { python: f.adapter },
      new AbortController().signal,
    );
  await f.add("b");
  f.fail("b");
  expect((await run()).complete).toBe(false);
  await rm(join(f.root, "b"), { recursive: true });
  expect((await run()).complete).toBe(true);
  expect(f.counts().resolves).toBe(1);
  await rename(join(f.root, "a"), join(f.root, "moved"));
  await expect(
    withReadyTypecheckTarget(
      f.root,
      "python:a/pyproject.toml",
      { python: f.adapter },
      async () => true,
    ),
  ).rejects.toThrow("Unknown project_id");
  expect(f.counts().resolves).toBe(1);
});

test("JavaScript shares exact TypeScript across failure/restart and relinquishes lint ownership", async () => {
  const f = await fixture("javascript");
  const run = () =>
    prepareTypecheck(
      f.root,
      { javascript: f.adapter },
      new AbortController().signal,
    );
  expect((await run()).complete).toBe(true);
  const lintPath = join(f.root, ".justomp/lint_state.json");
  const lint = {
    schema: 1,
    projects: {
      "javascript:a/package.json": {
        ecosystem: "javascript",
        tools: { eslint: "9.0.0", typescript: "1.0.0" },
        policy_hash: "old-lint-policy",
        ready: true,
      },
    },
  };
  await writeFile(lintPath, JSON.stringify(lint));
  await f.add("b");
  f.latest("2.0.0");
  f.fail("b");
  expect((await run()).complete).toBe(false);
  const invalidated = JSON.parse(await readFile(lintPath, "utf8")).projects[
    "javascript:a/package.json"
  ];
  expect(invalidated.ready).toBe(false);
  expect(invalidated.tools).toEqual({});
  expect(invalidated.policy_hash).toBe("old-lint-policy");
  const lintState = JSON.parse(await readFile(lintPath, "utf8"));
  expect(lintState.waves.javascript.complete).toBe(false);
  expect(
    lintState.waves.javascript.versions["javascript:a/package.json"],
  ).toEqual({});
  await expect(
    withReadyTypecheckTarget(
      f.root,
      "javascript:a/package.json",
      { javascript: f.adapter },
      async () => true,
    ),
  ).rejects.toThrow("wave");
  f.latest("3.0.0");
  f.fail("");
  expect((await run()).complete).toBe(true);
  expect(f.counts().resolves).toBe(2);
  for (const name of ["a", "b"])
    expect(
      JSON.parse(await readFile(join(f.root, name, "installed.json"), "utf8")),
    ).toEqual({ typescript: "2.0.0" });
});

test("native workspace batch sees ready members alongside a newly discovered member", async () => {
  const f = await fixture("javascript");
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({
      name: "root",
      packageManager: "npm@11.0.0",
      workspaces: ["a", "b"],
    }),
  );
  const original = f.adapter.prepareBatch;
  const batches: string[][] = [];
  f.adapter.prepareBatch = async (context) => {
    batches.push(context.targets.map((t) => t.project.path).sort());
    await original(context);
  };
  const run = () =>
    prepareTypecheck(
      f.root,
      { javascript: f.adapter },
      new AbortController().signal,
    );
  expect((await run()).complete).toBe(true);
  await f.add("b");
  expect((await run()).complete).toBe(true);
  expect(batches.at(-1)).toEqual([".", "a", "b"]);
});

test("temporarily unresolved live member retains its exact wave target", async () => {
  const f = await fixture();
  const run = () =>
    prepareTypecheck(
      f.root,
      { python: f.adapter },
      new AbortController().signal,
    );
  expect((await run()).complete).toBe(true);
  await f.add("b");
  f.latest("2.0.0");
  f.fail("b");
  expect((await run()).complete).toBe(false);
  await writeFile(
    join(f.root, "b/pyproject.toml"),
    '[project]\nname="b"\nversion="0.1.0"\n',
  );
  f.latest("3.0.0");
  f.fail("");
  expect((await run()).complete).toBe(false);
  const state = JSON.parse(
    await readFile(join(f.root, ".justomp/typecheck_state.json"), "utf8"),
  );
  expect(state.waves.python.projects).toContain("python:b/pyproject.toml");
  await f.add("b");
  expect((await run()).complete).toBe(true);
  expect(f.counts().resolves).toBe(2);
  expect(
    JSON.parse(await readFile(join(f.root, "b/installed.json"), "utf8")),
  ).toEqual({ pyright: "2.0.0" });
});

test("Go preparation refreshes installed runtime receipts after an upgrade", async () => {
  const f = await fixture();
  await rm(join(f.root, "a"), { recursive: true });
  await writeFile(join(f.root, "go.mod"), "module example.test/app\ngo 1.25\n");
  let installed = "1.25.5";
  const adapter = {
    ...f.adapter,
    async resolve(targets: Parameters<typeof f.adapter.resolve>[0]) {
      return Object.fromEntries(
        targets.map((target) => [target.project.project_id, { go: installed }]),
      );
    },
    async prepareBatch() {},
    async verifyTools(context: Parameters<typeof f.adapter.verifyTools>[0]) {
      return context.versions.go === installed;
    },
  };
  const run = () =>
    prepareTypecheck(f.root, { go: adapter }, new AbortController().signal);
  expect((await run()).complete).toBe(true);
  installed = "1.25.6";
  const upgraded = await run();
  expect(upgraded.complete).toBe(true);
  expect(upgraded.tools).toEqual({ go: "1.25.6" });
});
