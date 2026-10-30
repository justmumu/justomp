import { expect, test } from "bun:test";
import { goAdapter } from "../../../../src/dependencies/adapters/go";
import { parseInventory } from "../../../../src/dependencies/inventory";
import { validateDependencyGroup } from "../../../../src/dependencies/request";
import { memoryContext } from "../memory";

function fixture() {
  const f = memoryContext({
    project_id: "go:go.mod",
    manifest: "go.mod",
    ecosystem: "go",
    manager: "go",
    managerCandidates: ["go"],
    name: "example.test/app",
  });
  const text = "module example.test/app\ngo 1.25\n";
  f.write("go.mod", text);
  return { ...f, inventory: parseInventory(f.context.project, text) };
}
for (const location of ["go.mod", "go.work"] as const)
  for (const kind of ["registry", "git"] as const)
    test(`Go rejects ${kind} add shadowed by an unused ${location} replacement`, async () => {
      const f = fixture();
      try {
        f.write(
          location,
          `${location === "go.mod" ? "module example.test/app\n" : "use .\n"}go 1.25\nreplace example.test/lib => ./local\n`,
        );
        await expect(
          goAdapter.plan(
            f.context,
            {
              operation: "add",
              project_id: f.context.project.project_id,
              group: { kind: "runtime" },
              packages: [
                {
                  name: "example.test/lib",
                  source:
                    kind === "registry"
                      ? { kind: "registry" }
                      : {
                          kind: "git",
                          url: "example.test/lib",
                          ref: "feature",
                        },
                },
              ],
            },
            f.inventory,
          ),
        ).rejects.toMatchObject({ code: "unsupported-source-operation" });
      } finally {
        f.close();
      }
    });
for (const override of [
  "workspace member",
  "member replacement",
  "version-specific replacement",
  "module replacement",
] as const)
  test(`Go registry source rejects ${override}`, async () => {
    const f = fixture();
    try {
      if (
        override === "workspace member" ||
        override === "member replacement"
      ) {
        f.context.structure.projects.push({
          ...f.context.project,
          project_id: "go:local/go.mod",
          path: "local",
          manifest: "local/go.mod",
        });
        f.write("go.work", "go 1.25\nuse (\n .\n ./local\n)\n");
        f.write(
          "local/go.mod",
          override === "workspace member"
            ? "module example.test/lib\ngo 1.25\n"
            : "module example.test/other\ngo 1.25\nreplace example.test/lib => ../replacement\n",
        );
      } else
        f.write(
          "go.mod",
          `module example.test/app\ngo 1.25\nreplace example.test/lib ${override === "version-specific replacement" ? "v1.0.0 => ./local" : "=> example.test/transitive v1.0.0"}\n`,
        );
      await expect(
        goAdapter.plan(
          f.context,
          {
            operation: "add",
            project_id: f.context.project.project_id,
            group: { kind: "runtime" },
            packages: [
              {
                name: "example.test/lib",
                version: "1.0.0",
                source: { kind: "registry" },
              },
            ],
          },
          f.inventory,
        ),
      ).rejects.toMatchObject({ code: "unsupported-source-operation" });
    } finally {
      f.close();
    }
  });
test("Go accepts only runtime groups and rejects runtime management names and arbitrary Git URLs", async () => {
  const f = fixture();
  try {
    expect(goAdapter.groups).toEqual(["runtime"]);
    expect(() =>
      validateDependencyGroup(
        {
          operation: "add",
          project_id: f.context.project.project_id,
          group: { kind: "dev" },
          packages: [
            { name: "example.test/lib", source: { kind: "registry" } },
          ],
        },
        goAdapter.groups,
        "go",
      ),
    ).toThrow("go has no native dev group");
    for (const pkg of [
      { name: "toolchain", source: { kind: "registry" as const } },
      {
        name: "example.test/lib",
        source: {
          kind: "git" as const,
          url: "https://example.test/lib.git",
          ref: "feature",
        },
      },
    ])
      await expect(
        goAdapter.plan(
          f.context,
          {
            operation: "add",
            project_id: f.context.project.project_id,
            group: { kind: "runtime" },
            packages: [pkg],
          },
          f.inventory,
        ),
      ).rejects.toThrow();
  } finally {
    f.close();
  }
});
