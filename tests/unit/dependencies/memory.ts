import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { type Project } from "../../../src/inspect/model";
import { context as jsContext } from "./adapters/npm-pnpm-fixture";

/** Supplied metadata only: no temporary directories, scanners or native tools. */
export function memoryContext(project: Partial<Project> = {}) {
  const context = jsContext("npm");
  context.cwd = context.root;
  context.owner = context.root;
  Object.assign(context.project, {
    path: ".",
    manifest: "package.json",
    project_id: "javascript:package.json",
    managerRoot: ".",
    workspace: undefined,
    name: "app",
    ...project,
  });
  context.manager = context.project.manager ?? "npm";
  context.structure.projects = [context.project];
  const files = new Map<string, string>();
  const read = spyOn(fs, "readFile").mockImplementation((async (path: unknown, encoding?: unknown) => {
    const value = files.get(String(path));
    if (value === undefined) {
      throw Object.assign(new Error(`Missing supplied file: ${String(path)}`), {
        code: "ENOENT",
      });
    }
    return encoding === "utf8" ? value : Buffer.from(value);
  }) as typeof fs.readFile);
  const access = spyOn(fs, "access").mockImplementation(async (path) => {
    if (!files.has(String(path))) {
      throw Object.assign(new Error(`Missing supplied file: ${String(path)}`), {
        code: "ENOENT",
      });
    }
  });
  return {
    context,
    root: context.root,
    files,
    write(path: string, value: string) {
      files.set(path.startsWith("/") ? path : join(context.root, path), value);
    },
    close() {
      read.mockRestore();
      access.mockRestore();
    },
  };
}
