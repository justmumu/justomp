import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DependencyError } from "../../../src/dependencies/model";
import * as paths from "../../../src/dependencies/paths";
import { validateExistingSources } from "../../../src/dependencies/source-boundaries";
import { memoryContext } from "./memory";

function fixture(ecosystem: "javascript" | "python" = "javascript") {
  const f = memoryContext({
    ecosystem,
    manifest: ecosystem === "python" ? "pyproject.toml" : "package.json",
    manager: ecosystem === "python" ? "uv" : "npm",
  });
  const canonical = spyOn(fs, "realpath").mockImplementation((async (path: unknown) =>
    String(path)) as typeof fs.realpath);
  const checked: string[] = [];
  const safe = spyOn(paths, "safePath").mockImplementation(async (_root, path) => {
    checked.push(path);
    if (path === join(f.root, "linked") || path === join(f.root, "escape;segment")) {
      throw new DependencyError("outside-root", "Supplied canonical destination is outside root");
    }
    return path;
  });
  return {
    ...f,
    checked,
    validate: () => validateExistingSources(f.root, f.context.project, f.context.structure),
    close() {
      safe.mockRestore();
      canonical.mockRestore();
      f.close();
    },
  };
}
for (const protocol of ["link:", "portal:", "file:", "workspace:", "file://"]) {
  test(`source validation routes ${protocol} declarations through canonical containment`, async () => {
    const f = fixture();
    f.write(
      "package.json",
      JSON.stringify({
        dependencies: {
          linked: protocol === "file://" ? `file://${f.root}/linked` : `${protocol}./linked`,
        },
      }),
    );
    try {
      await expect(f.validate()).rejects.toMatchObject({
        code: "outside-root",
      });
      expect(f.checked).toContain(join(f.root, "linked"));
    } finally {
      f.close();
    }
  });
}
for (const field of ["overrides", "resolutions", "catalog", "catalogs"]) {
  test(`source validation checks nested root ${field} entries`, async () => {
    const f = fixture();
    f.write("package.json", JSON.stringify({ [field]: { nested: { linked: "file:./linked" } } }));
    try {
      await expect(f.validate()).rejects.toMatchObject({
        code: "outside-root",
      });
      expect(f.checked).toContain(join(f.root, "linked"));
    } finally {
      f.close();
    }
  });
}
test("pnpm catalog paths use workspace owner rather than selected member", async () => {
  const f = fixture();
  f.context.project.manager = "pnpm";
  Object.assign(f.context.project, {
    manifest: "app/package.json",
    path: "app",
  });
  f.write("package.json", JSON.stringify({ name: "owner" }));
  f.write("app/package.json", JSON.stringify({ dependencies: { linked: "catalog:" } }));
  f.write("pnpm-workspace.yaml", 'packages: ["app"]\ncatalog:\n  linked: "file:./linked"\n');
  try {
    await expect(f.validate()).rejects.toMatchObject({ code: "outside-root" });
    expect(f.checked).toContain(join(f.root, "linked"));
    expect(f.checked).not.toContain(join(f.root, "app/linked"));
  } finally {
    f.close();
  }
});
test("uv validates direct references in sibling groups without confusing URL semicolons with markers", async () => {
  const f = fixture("python");
  Object.assign(f.context.project, {
    manifest: "apps/api/pyproject.toml",
    path: "apps/api",
  });
  f.context.structure.projects.push({
    ...f.context.project,
    manifest: "apps/worker/pyproject.toml",
    path: "apps/worker",
    project_id: "python:worker",
  });
  f.write("pyproject.toml", '[tool.uv.workspace]\nmembers=["apps/*"]\n');
  f.write("apps/api/pyproject.toml", '[project]\nname="api"\nversion="1"\n');
  f.write(
    "apps/worker/pyproject.toml",
    '[project]\nname="worker"\nversion="1"\n[dependency-groups]\ndev=["linked @ file:../../escape;segment ; python_version > \'3.10\'"]\n',
  );
  try {
    await expect(f.validate()).rejects.toMatchObject({ code: "outside-root" });
    expect(f.checked).toContain(join(f.root, "escape;segment"));
  } finally {
    f.close();
  }
});
