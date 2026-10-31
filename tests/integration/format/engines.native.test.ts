import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFormatConfig } from "../../../src/config/format/resolve";
import { runProcess } from "../../../src/dependencies/runner";
import { measureFixture } from "../../fixtures/cost-timing";

test("bundled Prettier/TOML loads in a target without Node dependencies and ignores ambient config", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-format-api-"));
  try {
    await measureFixture("format.prettier.prepare", async () => {
      await writeFile(
        join(root, "pyproject.toml"),
        '[project]\nname="sample"\n',
      );
      await writeFile(
        join(root, ".prettierrc"),
        '{"singleQuote":false,"semi":false}',
      );
      await writeFile(
        join(root, ".editorconfig"),
        "root=true\n[*]\nindent_size=8\n",
      );
      await writeFile(
        join(root, "taplo.toml"),
        "[formatting]\nreorder_keys=false\ncolumn_width=1\n",
      );
      await writeFile(
        join(root, "tombi.toml"),
        "[format.rules]\nline-width=1\n",
      );
    });
    const policy = resolveFormatConfig({
      prettier: {
        singleQuote: true,
        reorderKeys: true,
        parser: "not-a-parser",
        plugins: ["missing-untrusted-plugin"],
      },
    }).policy.prettier;
    const result = await runProcess(
      process.execPath,
      [
        "--eval",
        `
      import { formatPrettier, checkPrettier, prettierVersion } from ${JSON.stringify(import.meta.resolve("../../../src/format/engines/prettier"))};
      const policy = ${JSON.stringify(policy)};
      const js = await formatPrettier('const value="ok"', "babel", policy);
      const toml = await formatPrettier(${JSON.stringify("z=1\na=2\n")}, "toml", policy);
      console.log(JSON.stringify({js,toml,version:prettierVersion,clean:await checkPrettier(js,"babel",policy) && await checkPrettier(toml,"toml",policy),unchanged:toml === await formatPrettier(toml,"toml",policy)}));
    `,
      ],
      { cwd: root },
    );
    expect(result.exit_code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      js: "const value = 'ok';\n",
      toml: "a = 2\nz = 1\n",
      version: "3.9.10",
      clean: true,
      unchanged: true,
    });
    expect((await readdir(root)).sort()).toEqual([
      ".editorconfig",
      ".prettierrc",
      "pyproject.toml",
      "taplo.toml",
      "tombi.toml",
    ]);
  } finally {
    await measureFixture("format.prettier.cleanup", () =>
      rm(root, { recursive: true, force: true }),
    );
  }
});
