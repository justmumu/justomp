import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ProcessResult } from "../../../src/dependencies/model";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { git, gitText } from "../../../src/precommit/git";
import { installPrecommit } from "../../../src/precommit/install";
import { type PrecommitResult } from "../../../src/precommit/model";
import { nativeOperations } from "../../../src/precommit/operations";
import { measureFixture } from "../../fixtures/cost-timing";
import { VERSION as RUFF } from "../../fixtures/lint/python/fixture";
import { VERSION as PYRIGHT, pythonFixture } from "../../fixtures/typecheck/python/fixture";

function hookResult(result: ProcessResult): PrecommitResult {
  // Git forwards hook stdout to stderr, alongside the human-readable summary.
  const line = result.stderr.split("\n").find((line) => line.startsWith('{"success":'));
  if (!line) {
    throw new Error(`Missing hook result: ${result.stderr}`);
  }
  return JSON.parse(line) as PrecommitResult;
}

test("installed hook composes native fixes, checks and staging across failure and retry", async () => {
  const fixture = await pythonFixture();
  const { root } = fixture;
  const original = globalThis.fetch;
  try {
    // Pin only registry selection during setup; the hook runs real installed tools.
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const name = String(input).split("/").at(-2);
        const version = name === "ruff" ? RUFF : name === "pyright" ? PYRIGHT : undefined;
        if (!version) {
          throw new Error(`Unexpected registry ${input}`);
        }
        return Response.json({ releases: { [version]: [{ yanked: false }] } });
      },
      { preconnect: original.preconnect },
    );
    const prepared = await measureFixture("precommit.native.prepare", () =>
      nativeOperations.prepare(root, new AbortController().signal),
    );
    expect(prepared.success).toBe(true);
    globalThis.fetch = original;
    await gitText(root, ["init", "-q"]);
    await gitText(root, ["config", "user.name", "Test"]);
    await gitText(root, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, ".gitignore"), ".justomp/\n.venv/\n.ruff_cache/\n__pycache__/\n");
    await writeFile(join(root, "module.py"), '"""An example module."""\n\nimport os\n\nVALUE: str = \'example\'\n');
    await gitText(root, ["add", "--", "module.py", "pyproject.toml", "uv.lock", ".gitignore"]);
    expect((await installPrecommit(root)).status).toBe("installed");
    const first = await git(root, ["commit", "-m", "test: native flow"]);
    expect(first.exit_code).toBe(0);
    const successful = hookResult(first);
    expect(successful.success).toBe(true);
    expect(successful.stages.map((stage) => stage.stage)).toEqual([
      "preparation",
      "fix",
      "format",
      "lint",
      "typecheck",
      "dependency",
    ]);
    expect(await gitText(root, ["show", "HEAD:module.py"])).toBe(
      '"""An example module."""\n\nVALUE: str = "example"\n',
    );

    // Reuse the prepared project: a completed check failure still stages owned fixes.
    const head = await gitText(root, ["rev-parse", "HEAD"]);
    await writeFile(join(root, "module.py"), '"""An example module."""\n\nVALUE: str = \'changed\'\n');
    await writeFile(join(root, "bad.py"), '"""A failing check witness."""\n\nVALUE: int = "bad"\n');
    await gitText(root, ["add", "--", "module.py", "bad.py"]);
    const failed = await git(root, ["commit", "-m", "test: blocked check"]);
    expect(failed.exit_code).not.toBe(0);
    const blocked = hookResult(failed);
    expect(blocked.complete).toBe(true);
    expect(blocked.stages.find((stage) => !stage.success)?.stage).toBe("typecheck");
    expect(await gitText(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(blocked.staged_files).toContain("module.py");
    const fixed = '"""An example module."""\n\nVALUE: str = "changed"\n';
    expect(await gitText(root, ["show", ":module.py"])).toBe(fixed);

    await writeFile(join(root, "bad.py"), '"""A failing check witness."""\n\nVALUE: int = 1\n');
    await gitText(root, ["add", "--", "bad.py"]);
    const retry = await git(root, ["commit", "-m", "test: retry check"]);
    expect(retry.exit_code).toBe(0);
    expect(hookResult(retry).success).toBe(true);
    expect(await gitText(root, ["show", "HEAD:module.py"])).toBe(fixed);
  } finally {
    globalThis.fetch = original;
    await closePackagingStructure(root);
    await measureFixture("precommit.native.cleanup", () => fixture.dispose());
  }
}, 60000);
