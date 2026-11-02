import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkProjectFormat } from "../../../src/format/check";
import { formatProject } from "../../../src/format/service";
import { closePackagingStructure, getPackagingStructure } from "../../../src/packaging/get-structure";
import { git, gitText } from "../../../src/precommit/git";
import { installPrepush } from "../../../src/prepush/install";
import { type PrepushResult } from "../../../src/prepush/model";
import { createPushOperations } from "../../../src/prepush/operations";
import { measureFixture } from "../../fixtures/cost-timing";
import { VERSION as RUFF } from "../../fixtures/lint/python/fixture";
import { VERSION as PYRIGHT, pythonFixture } from "../../fixtures/typecheck/python/fixture";

function result(stderr: string): PrepushResult {
  const line = stderr.split("\n").find((l) => l.startsWith('{"success":'));
  if (!line) {
    throw new Error(`Missing hook output: ${stderr}`);
  }
  return JSON.parse(line) as PrepushResult;
}
test("native pre-push checks prepared Python project and blocks failing unit tests", async () => {
  const fixture = await pythonFixture();
  const { root } = fixture;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const name = String(input).split("/").at(-2);
        const version = name === "ruff" ? RUFF : name === "pyright" ? PYRIGHT : undefined;
        return version ? Response.json({ releases: { [version]: [{ yanked: false }] } }) : original(input, init);
      },
      { preconnect: original.preconnect },
    );
    await mkdir(join(root, "tests/unit"), { recursive: true });
    await writeFile(join(root, "module.py"), '"""Native gate source."""\n\nVALUE: int = 42\n');
    const testSource =
      '"""Native gate test."""\n\nfrom module import VALUE\n\ndef test_value() -> None:\n    """Exercise the source."""\n    assert VALUE == 42\n';
    await writeFile(join(root, "tests/unit/test_module.py"), testSource);
    const signal = new AbortController().signal;
    const prepared = await measureFixture("prepush.native.prepare", () => createPushOperations().prepare(root, signal));
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    globalThis.fetch = original;
    const id = (await getPackagingStructure(root, { refresh: true })).structure.projects[0]?.project_id ?? "missing";
    expect((await formatProject(root, id)).success).toBe(true);
    // Metadata is part of the same formatter scope and is checked without a write.
    await writeFile(join(root, "example.json"), '{"value":42}');
    const badFormat = await checkProjectFormat(root, id, signal);
    expect(badFormat.complete).toBe(true);
    expect(badFormat.files.find((f) => f.path === "example.json")?.status).toBe("unformatted");
    expect(await readFile(join(root, "example.json"), "utf8")).toBe('{"value":42}');
    expect((await formatProject(root, id)).success).toBe(true);
    await gitText(root, ["init", "-q", "-b", "main"]);
    await gitText(root, ["config", "user.name", "Test"]);
    await gitText(root, ["config", "user.email", "test@example.invalid"]);
    await gitText(root, ["add", "--", "module.py", "tests", "pyproject.toml", "uv.lock", "example.json"]);
    await gitText(root, ["commit", "-m", "test: native push"]);
    const remote = join(root, "remote.git");
    await gitText(root, ["init", "--bare", "-q", remote]);
    await gitText(root, ["remote", "add", "origin", remote]);
    expect((await installPrepush(root)).status).toBe("installed");
    const passed = await git(root, ["push", "origin", "main"]);
    const successful = result(`${passed.stdout}\n${passed.stderr}`);
    expect(successful.errors).toEqual([]);
    expect(successful.success).toBe(true);
    expect(passed.exit_code).toBe(0);
    expect(successful.stages.map((s) => s.stage)).toEqual([
      "dependency",
      "preparation",
      "format",
      "lint",
      "typecheck",
      "unit",
    ]);
    const before = await gitText(remote, ["rev-parse", "main"]);
    // Deliberately uncommitted test change proves that the current tree is checked.
    const formattedTest = await readFile(join(root, "tests/unit/test_module.py"), "utf8");
    await writeFile(join(root, "tests/unit/test_module.py"), formattedTest.replace("== 42", "== 43"));
    await gitText(root, ["commit", "--allow-empty", "-m", "test: failing unit witness"]);
    const failed = await git(root, ["push", "origin", "main"]);
    const blocked = result(`${failed.stdout}\n${failed.stderr}`);
    expect(blocked.complete).toBe(true);
    expect(blocked.stages.find((s) => !s.success)?.stage).toBe("unit");
    expect(failed.exit_code).not.toBe(0);
    expect(await gitText(remote, ["rev-parse", "main"])).toBe(before);
    expect(await readFile(join(root, "tests/unit/test_module.py"), "utf8")).toContain("== 43");
  } finally {
    globalThis.fetch = original;
    await closePackagingStructure(root);
    await measureFixture("prepush.native.cleanup", () => fixture.dispose());
  }
}, 60000);
