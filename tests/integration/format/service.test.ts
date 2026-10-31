import { expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prettier from "../../../src/format/engines/prettier";
import { formatProject } from "../../../src/format/service";
import { closePackagingStructure } from "../../../src/packaging/get-structure";

// Boundary: real discovery -> bundled API -> atomic writes and metadata refresh.
// No native installs. Setup and cleanup are included in test duration.
test("formats selected protected metadata, preserves mode and is unchanged on repetition", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "format-service-")));
  try {
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\nname="demo"\nversion="0.1.0"\n[tool.uv]\npackage=false\n',
    );
    await writeFile(join(root, "README.md"), "#   Hello\n");
    await chmod(join(root, "README.md"), 0o755);
    const first = await formatProject(root, "python:pyproject.toml", {
      files: ["README.md", "pyproject.toml"],
    });
    expect(first.success, JSON.stringify(first)).toBe(true);
    expect(first.files.map((file) => file.status)).toEqual([
      "changed",
      "changed",
    ]);
    expect(first.preparation_changes.map((change) => change.path)).toEqual([
      ".justomp/config.json",
    ]);
    expect(first.formatters).toEqual([
      { engine: "prettier", version: expect.any(String) },
    ]);
    expect((await stat(join(root, "README.md"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# Hello\n");
    const again = await formatProject(root, "python:pyproject.toml", {
      files: ["README.md", "pyproject.toml"],
    });
    expect(again.success, JSON.stringify(again)).toBe(true);
    expect(again.files.every((file) => file.status === "unchanged")).toBe(true);
    expect(again.preparation_changes).toEqual([]);
  } finally {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
// Boundary: an editor writes between the formatter read and atomic publication.
test("format publication refuses a source edit made while the API is running", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "format-conflict-")),
  );
  const actual = prettier.formatPrettier;
  let formatter:
    | ReturnType<typeof spyOn<typeof prettier, "formatPrettier">>
    | undefined;
  try {
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\nname="demo"\nversion="0.1.0"\n[tool.uv]\npackage=false\n',
    );
    await writeFile(join(root, "README.md"), "#   Hello\n");
    formatter = spyOn(prettier, "formatPrettier").mockImplementation(
      async (text, parser, policy) => {
        await writeFile(join(root, "README.md"), "User's concurrent edit\n");
        return actual(text, parser, policy);
      },
    );
    const result = await formatProject(root, "python:pyproject.toml", {
      files: ["README.md"],
    });
    expect(result.success).toBe(false);
    expect(result.files[0]?.error?.code).toBe("projection-conflict");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(
      "User's concurrent edit\n",
    );
  } finally {
    formatter?.mockRestore();
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
// Boundary: a directory becomes an in-project symlink after selection and snapshot.
test("publication rejects a new symlink component even when it points inside the project", async () => {
  const { mkdir, rename, symlink } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "format-symlink-")));
  const actual = prettier.formatPrettier;
  let formatter:
    | ReturnType<typeof spyOn<typeof prettier, "formatPrettier">>
    | undefined;
  try {
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\nname="demo"\nversion="0.1.0"\n[tool.uv]\npackage=false\n',
    );
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/README.md"), "#   Hello\n");
    formatter = spyOn(prettier, "formatPrettier").mockImplementation(
      async (text, parser, policy) => {
        await rename(join(root, "docs"), join(root, "original"));
        await symlink("original", join(root, "docs"));
        return actual(text, parser, policy);
      },
    );
    const result = await formatProject(root, "python:pyproject.toml", {
      files: ["docs/README.md"],
    });
    expect(result.files[0]?.error?.code).toBe("unsafe-path");
    expect(await readFile(join(root, "original/README.md"), "utf8")).toBe(
      "#   Hello\n",
    );
  } finally {
    formatter?.mockRestore();
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
