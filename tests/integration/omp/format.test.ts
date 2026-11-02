import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prettier from "../../../src/format/engines/prettier";
import registerInspection from "../../../src/omp/extension";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { createHost } from "./host";

// Real OMP registration, approval wrapper and session teardown. No native installations.
async function fixture(deny: string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omp-format-")));
  await writeFile(join(root, "pyproject.toml"), '[project]\nname="demo"\nversion="0.1.0"\n[tool.uv]\npackage=false\n');
  const host = await createHost(root, undefined, deny, registerInspection);
  return {
    root,
    host,
    async close() {
      await host.close();
      await closePackagingStructure(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("OMP format has strict ID/files exec schema and trusted manifest writes return matching JSON/details", async () => {
  const f = await fixture();
  try {
    const tool = f.host.runner.getRegisteredTool("project_format");
    expect(tool?.definition.approval).toBe("exec");
    const schema = tool?.definition.parameters as {
      safeParse(input: unknown): { success: boolean };
    };
    for (const input of [
      {},
      { project_id: "x", files: [] },
      { project_id: "x", cwd: "/tmp" },
      { project_id: "x", ecosystem: "python" },
    ]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
    const response = await f.host.getTool("project_format").execute("format", {
      project_id: "python:pyproject.toml",
      files: ["pyproject.toml"],
    });
    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed).toEqual(response.details);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    expect(parsed.files).toEqual([{ path: "pyproject.toml", engine: "prettier", status: "changed" }]);
    expect(await readFile(join(f.root, "pyproject.toml"), "utf8")).toContain('name = "demo"');
    const invalid = await f.host.getTool("project_format").execute("invalid", {
      project_id: "python:pyproject.toml",
      files: ["missing.md"],
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await f.close();
  }
  const denied = await fixture(["project_format"]);
  try {
    await expect(
      denied.host.getTool("project_format").execute("deny", { project_id: "python:pyproject.toml" }),
    ).rejects.toThrow();
    expect(await Bun.file(join(denied.root, ".justomp/config.json")).exists()).toBe(false);
  } finally {
    await denied.close();
  }
});
test("OMP shutdown waits for active formatting cleanup and prevents a late publish", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "README.md"), "before\n");
  let enter = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const format = spyOn(prettier, "formatPrettier").mockImplementation(async () => {
    enter();
    await gate;
    return "after\n";
  });
  try {
    const running = f.host.getTool("project_format").execute("active", {
      project_id: "python:pyproject.toml",
      files: ["README.md"],
    });
    await entered;
    let closed = false;
    const closing = f.host.runner.emit({ type: "session_shutdown" }).then(() => {
      closed = true;
    });
    await Bun.sleep(20);
    expect(closed).toBe(false);
    release();
    const result = await running;
    await closing;
    expect(result.details).toMatchObject({ success: false, cancelled: true });
    expect(await readFile(join(f.root, "README.md"), "utf8")).toBe("before\n");
  } finally {
    release();
    format.mockRestore();
    await f.close();
  }
});
