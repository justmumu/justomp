import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORMAT_DEFAULTS } from "../../../src/config/format/defaults";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { collectFormatScope } from "../../../src/format/scope";
import { selectFormatFiles } from "../../../src/format/selection";
import { target } from "../../unit/checks/fixture";

// Real boundary: directory entries, canonical custom dependencies and symlink containment.
// No tool installation; fixture setup/cleanup are included in the test duration.
test("format walker omits symlinks and custom dependency roots without touching outside files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "format-scope-")));
  try {
    const selected = target("python");
    selected.root = root;
    selected.scope.cwd = join(root, "apps/app");
    selected.scope.owner = selected.scope.cwd;
    selected.scope.env.UV_PROJECT_ENVIRONMENT = "env-alias";
    for (const [path, content] of [
      ["apps/app/src/main.py", "x=1\n"],
      ["apps/app/README.md", "# Hello\n"],
      ["apps/app/.env-store/foreign.py", "dependency\n"],
      ["apps/app/child/nested.py", "child\n"],
      ["outside.py", "outside\n"],
    ] as const) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    selected.structure.projects.push({
      ...selected.project,
      path: "apps/app/child",
    });
    await symlink(".env-store", join(selected.scope.cwd, "env-alias"));
    await symlink("../../outside.py", join(selected.scope.cwd, "alias.py"));
    await symlink(root, join(selected.scope.cwd, "outside"));
    const scope = await collectFormatScope(selected, FORMAT_DEFAULTS, resolveLintConfig().policy);
    expect(scope.files).toEqual(["README.md", "src/main.py"]);
    expect(() => selectFormatFiles(scope, ["alias.py"])).toThrow("not an owned supported file");
    expect(await readFile(join(root, "outside.py"), "utf8")).toBe("outside\n");
    expect(await readFile(join(selected.scope.cwd, ".env-store/foreign.py"), "utf8")).toBe("dependency\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Reuses only filesystem discovery; no Go binary or installation is needed for rejection.
test("Go native-only exclusions reject source before execution but allow explicit common files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "format-go-scope-")));
  try {
    const selected = target("go");
    selected.root = root;
    selected.scope.cwd = root;
    selected.scope.owner = root;
    await writeFile(join(root, "main.go"), "package test\n");
    await writeFile(join(root, "README.md"), "# Test\n");
    const lint = resolveLintConfig().policy;
    lint.go.golangci.formatters.exclusions.paths = ["^private/"];
    await expect(collectFormatScope(selected, FORMAT_DEFAULTS, lint)).rejects.toThrow("formatters.exclusions.paths");
    expect((await collectFormatScope(selected, FORMAT_DEFAULTS, lint, ["README.md"])).files).toEqual(["README.md"]);
    expect(await readFile(join(root, "main.go"), "utf8")).toBe("package test\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
