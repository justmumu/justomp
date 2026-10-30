import { expect, test } from "bun:test";
import { inspectDocuments } from "./fixture";

test("workspace membership is separate from explicit local dependency", async () => {
  const root: Record<string, string> = structuredClone({
    "package.json": '{"name":"root","packageManager":"pnpm@10.0.0"}',
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "apps/web/package.json":
      '{"name":"web","dependencies":{"ui":"workspace:*"}}',
    "packages/ui/package.json": '{"name":"ui"}',
    "packages/other/package.json": '{"name":"other"}',
  });
  const r = inspectDocuments({ root });
  expect(r.workspaces[0]?.members).toContain(
    "javascript:packages/ui/package.json",
  );
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["javascript:apps/web/package.json", "javascript:packages/ui/package.json"],
  ]);
});

test("uv workspace/path and Go required local replace resolve without invented edges", async () => {
  const root: Record<string, string> = structuredClone({
    "pyproject.toml":
      '[project]\nname="root"\nversion="1"\ndependencies=["lib"]\n[tool.uv.workspace]\nmembers=["packages/*"]\n[tool.uv.sources]\nlib={workspace=true}\n',
    "packages/lib/pyproject.toml": '[project]\nname="lib"\nversion="1"',
    "go.work": "go 1.24\nuse (\n ./go/a\n ./go/b\n)\n",
    "go/a/go.mod":
      "module example/a\ngo 1.24\nrequire example/b v1.0.0\nreplace example/b => ../b\nreplace example/unused => ../unused\n",
    "go/b/go.mod": "module example/b\ngo 1.24\n",
  });
  const r = inspectDocuments({ root });
  expect(r.complete).toBe(true);
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["go:go/a/go.mod", "go:go/b/go.mod"],
    ["python:pyproject.toml", "python:packages/lib/pyproject.toml"],
  ]);
  expect(r.workspaces).toHaveLength(2);
});

test("ambiguous names, excluded workspace members and conflicting managers are diagnosed", async () => {
  const root: Record<string, string> = structuredClone({
    "pnpm-workspace.yaml": 'packages: ["apps/*", ".hidden"]',
    "package.json": '{"name":"root","packageManager":"npm@10"}',
    "pnpm-lock.yaml": "",
    "apps/a/package.json": '{"name":"same"}',
    "apps/b/package.json": '{"name":"same"}',
    "apps/c/package.json":
      '{"name":"consumer","dependencies":{"same":"workspace:*"}}',
    ".hidden/package.json": '{"name":"hidden"}',
  });
  const r = inspectDocuments({ root });
  expect(r.localDependencies).toEqual([]);
  for (const code of [
    "ambiguous-target",
    "excluded-member",
    "manager-conflict",
  ])
    expect(r.diagnostics.some((d) => d.code === code)).toBe(true);
});

test("Go use may point to a sibling inside root and excluded ancestors diagnose lost membership", async () => {
  const root: Record<string, string> = structuredClone({
    "workspace/go.work": "go 1.24\nuse ../sibling\n",
    "sibling/go.mod": "module example/sibling\ngo 1.24\n",
    "pnpm-workspace.yaml": 'packages: ["hidden/*"]',
    "hidden/x/package.json": "{}",
  });
  const r = inspectDocuments({
    root,
    rules: { include: ["**/*"], exclude: ["hidden"] },
  });
  expect(r.workspaces.find((w) => w.kind === "go")?.members).toEqual([
    "go:sibling/go.mod",
  ]);
  expect(r.diagnostics.some((d) => d.code === "excluded-member")).toBe(true);
});

test("uv root sources apply to member dependencies; workspace manager evidence needs no lock", async () => {
  const root: Record<string, string> = structuredClone({
    "pyproject.toml":
      '[project]\nname="root"\nversion="1"\n[tool.uv.workspace]\nmembers=["packages/*"]\n[tool.uv.sources]\nlib={workspace=true}\n',
    "packages/app/pyproject.toml":
      '[project]\nname="app"\nversion="1"\ndependencies=["lib"]\n',
    "packages/lib/pyproject.toml": '[project]\nname="lib"\nversion="1"\n',
    "web/pnpm-workspace.yaml": 'packages: ["app"]',
    "web/app/package.json": '{"name":"web"}',
  });
  const r = inspectDocuments({ root });
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    [
      "python:packages/app/pyproject.toml",
      "python:packages/lib/pyproject.toml",
    ],
  ]);
  expect(r.projects.find((p) => p.name === "web")?.manager).toBe("pnpm");
  expect(r.projects.find((p) => p.name === "app")?.manager).toBe("uv");
});

test("pnpm native membership defaults to root and wildcard excludes dot names", async () => {
  const root: Record<string, string> = structuredClone({
    "package.json": '{"name":"root"}',
    "pnpm-workspace.yaml": "{}",
    "packages/a/package.json": '{"name":"a"}',
    "packages/.hidden/package.json": '{"name":"hidden"}',
  });
  const rules = { include: ["**/*"], exclude: [] };
  expect(inspectDocuments({ root, rules }).workspaces[0]?.members).toEqual([
    "javascript:package.json",
  ]);
  root["pnpm-workspace.yaml"] = 'packages: ["./packages//*"]';
  expect(inspectDocuments({ root, rules }).workspaces[0]?.members).toEqual([
    "javascript:package.json",
    "javascript:packages/a/package.json",
  ]);
});

test("virtual uv workspace root supplies sources without becoming a project", async () => {
  const root: Record<string, string> = structuredClone({
    "pyproject.toml":
      '[tool.uv.workspace]\nmembers=["packages/*"]\n[tool.uv.sources]\nlib={workspace=true}\nother={path="./local"}\n',
    "packages/app/pyproject.toml":
      '[project]\nname="app"\nversion="1"\ndependencies=["lib", "other"]\n',
    "packages/lib/pyproject.toml": '[project]\nname="lib"\nversion="1"\n',
    "local/pyproject.toml": '[project]\nname="other"\nversion="1"\n',
  });
  const r = inspectDocuments({ root });
  expect(r.projects.some((p) => p.path === ".")).toBe(false);
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["python:packages/app/pyproject.toml", "python:local/pyproject.toml"],
    [
      "python:packages/app/pyproject.toml",
      "python:packages/lib/pyproject.toml",
    ],
  ]);
  expect(
    r.diagnostics.some(
      (d) => d.code === "unresolved" && d.evidence?.field === "tool.uv.sources",
    ),
  ).toBe(false);
});

test("nearest nested workspace wins even when directory name has one character", async () => {
  const root: Record<string, string> = structuredClone({
    "pnpm-workspace.yaml": 'packages: ["**"]',
    "top/package.json": '{"name":"lib"}',
    "a/pnpm-workspace.yaml": 'packages: ["*"]',
    "a/lib/package.json": '{"name":"lib"}',
    "a/app/package.json": '{"name":"app","dependencies":{"lib":"workspace:*"}}',
  });
  const r = inspectDocuments({ root });
  expect(r.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["javascript:a/app/package.json", "javascript:a/lib/package.json"],
  ]);
});

for (const [manager, version, lock] of [
  ["npm", "10.9.0", "package-lock.json"],
  ["yarn", "1.22.22", "yarn.lock"],
  ["yarn", "4.9.1", "yarn.lock"],
  ["bun", "1.4.2", "bun.lock"],
] as const) {
  test(`${manager}@${version} workspaces inherit manager/version and root evidence`, async () => {
    const root: Record<string, string> = structuredClone({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: `${manager}@${version}`,
        workspaces:
          manager === "yarn" ? { packages: ["packages/*"] } : ["packages/*"],
      }),
      [lock]: "",
      "packages/app/package.json":
        '{"name":"app","dependencies":{"lib":"workspace:*"}}',
      "packages/lib/package.json": '{"name":"lib"}',
    });
    const report = inspectDocuments({ root });
    const app = report.projects.find((p) => p.name === "app");
    expect(report.workspaces[0]?.kind).toBe(manager);
    expect(app?.manager).toBe(manager);
    expect(app?.managerVersion).toBe(version);
    expect(app?.managerRoot).toBe(".");
    expect(app?.evidence).toContainEqual({
      file: lock,
      field: "presence",
      value: manager,
    });
    expect(report.localDependencies.map((d) => [d.from, d.to])).toEqual([
      [
        "javascript:packages/app/package.json",
        "javascript:packages/lib/package.json",
      ],
    ]);
    const projectIds = new Set(report.projects.map((p) => p.project_id));
    for (const workspace of report.workspaces)
      for (const id of workspace.members) expect(projectIds.has(id)).toBe(true);
  });
}

test("nested JavaScript workspace uses nearest owner without inheriting outer manager", async () => {
  const root: Record<string, string> = structuredClone({
    "package.json":
      '{"name":"root","packageManager":"npm@10.9.0","workspaces":["**"]}',
    "package-lock.json": "",
    "top/package.json": '{"name":"lib"}',
    "a/package.json":
      '{"name":"nested","packageManager":"yarn@4.9.1","workspaces":["*"]}',
    "a/yarn.lock": "",
    "a/lib/package.json": '{"name":"lib"}',
    "a/app/package.json": '{"name":"app","dependencies":{"lib":"workspace:*"}}',
  });
  const report = inspectDocuments({ root });
  const app = report.projects.find((p) => p.name === "app");
  expect(app?.manager).toBe("yarn");
  expect(app?.managerVersion).toBe("4.9.1");
  expect(app?.managerRoot).toBe("a");
  expect(app?.managerCandidates).toEqual(["yarn"]);
  expect(report.localDependencies.map((d) => [d.from, d.to])).toEqual([
    ["javascript:a/app/package.json", "javascript:a/lib/package.json"],
  ]);
});

test("unknown and conflicting owner evidence reaches members without selecting a manager", async () => {
  const root: Record<string, string> = structuredClone({
    "package.json":
      '{"name":"root","packageManager":"npm@10.9.0","workspaces":["member"]}',
    "yarn.lock": "",
    "member/package.json": '{"name":"member"}',
    "unknown/package.json":
      '{"name":"unknown","packageManager":"custom@1","workspaces":["member"]}',
    "unknown/package-lock.json": "",
    "unknown/member/package.json": '{"name":"unknown-member"}',
  });
  const report = inspectDocuments({ root });
  const member = report.projects.find((p) => p.name === "member");
  expect(member?.manager).toBeUndefined();
  expect(member?.managerCandidates).toEqual(["npm", "yarn"]);
  expect(member?.managerRoot).toBe(".");
  expect(member?.workspace).toBe(".:unsupported");
  const unknown = report.projects.find((p) => p.name === "unknown-member");
  expect(unknown?.manager).toBeUndefined();
  expect(unknown?.status).toBe("ambiguous");
  expect(unknown?.workspace).toBe("unknown:unsupported");
});

test("virtual workspace root supplies required version and conflicting lock evidence", async () => {
  const root: Record<string, string> = structuredClone({
    "pyproject.toml":
      '[tool.uv]\nrequired-version=">=0.9"\n[tool.uv.workspace]\nmembers=["packages/*"]',
    "uv.lock": "",
    "packages/app/pyproject.toml": '[project]\nname="app"\nversion="1"',
  });
  const app = inspectDocuments({ root }).projects[0];
  expect(app?.manager).toBe("uv");
  expect(app?.managerVersion).toBe(">=0.9");
  expect(app?.managerRoot).toBe(".");
  expect(app?.evidence).toContainEqual({
    file: "uv.lock",
    field: "presence",
    value: "uv",
  });
  root["poetry.lock"] = "";
  const conflict = inspectDocuments({ root }).projects[0];
  expect(conflict?.manager).toBeUndefined();
  expect(conflict?.managerCandidates).toEqual(["poetry", "uv"]);
});

test("a member cannot silently override its owner's required manager version", async () => {
  const root: Record<string, string> = structuredClone({
    "package.json":
      '{"name":"root","packageManager":"yarn@4.9.1","workspaces":["app"]}',
    "app/package.json": '{"name":"app","packageManager":"yarn@1.22.22"}',
  });
  const report = inspectDocuments({ root });
  const app = report.projects.find((p) => p.name === "app");
  expect(app?.manager).toBeUndefined();
  expect(app?.managerVersion).toBeUndefined();
  expect(
    report.diagnostics.some((d) => d.code === "manager-version-conflict"),
  ).toBe(true);
});

test("lock evidence resolves package workspaces and pnpm YAML remains its native declaration", async () => {
  const root: Record<string, string> = structuredClone({
    "package.json": '{"name":"root","workspaces":["packages/*"]}',
    "package-lock.json": "",
    "packages/app/package.json": '{"name":"app"}',
    "pnpm/package.json":
      '{"name":"pnpm-root","packageManager":"pnpm@10.0.0","workspaces":["ignored"]}',
    "pnpm/pnpm-workspace.yaml": 'packages: ["member"]',
    "pnpm/member/package.json": '{"name":"pnpm-member"}',
    "pnpm/ignored/package.json": '{"name":"ignored"}',
  });
  const report = inspectDocuments({ root });
  expect(report.workspaces.map((w) => w.kind)).toEqual(["npm", "pnpm"]);
  expect(report.projects.find((p) => p.name === "app")?.manager).toBe("npm");
  expect(
    report.projects.find((p) => p.name === "pnpm-member")?.managerVersion,
  ).toBe("10.0.0");
  expect(
    report.projects.find((p) => p.name === "ignored")?.workspace,
  ).toBeUndefined();
});

test("uv workspace root requirement wins over ignored member configuration", async () => {
  for (const metadata of ["", '[project]\nname="root"\nversion="1"\n']) {
    const root: Record<string, string> = structuredClone({
      "pyproject.toml": `${metadata}[tool.uv]\nrequired-version=">=0.9"\n[tool.uv.workspace]\nmembers=["app"]`,
      "app/pyproject.toml":
        '[project]\nname="app"\nversion="1"\n[tool.uv]\nrequired-version=">=0.8"',
    });
    const report = inspectDocuments({ root });
    const app = report.projects.find((p) => p.name === "app");
    expect(app?.manager).toBe("uv");
    expect(app?.managerVersion).toBe(">=0.9");
    expect(
      report.diagnostics.some((d) => d.code === "manager-version-conflict"),
    ).toBe(false);
  }
});
