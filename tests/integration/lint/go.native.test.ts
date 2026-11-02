import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../../../src/dependencies/runner";
import { checkGoFormat, formatGo } from "../../../src/format/engines/go";
import { assertFormatProcess } from "../../../src/format/engines/process";
import { goLintAdapter } from "../../../src/lint/adapters/go";
import { withGoEnvironment } from "../../../src/lint/go/environment";
import { golangciPath } from "../../../src/lint/go/install";
import { lintManagerContext } from "../../../src/lint/runtime";
import { measureFixture } from "../../fixtures/cost-timing";
import { artifactTransport, GO_LINT_VERSION, goFixture, officialArchive } from "../../fixtures/lint/go/fixture";
import { suppliedResponse } from "../../response";
import { createGoProxy } from "../dependencies/managers/go-proxy";
import { cleanups } from "./go-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("native Go setup is isolated and clean/format-only checks preserve project bytes", async () => {
  const f = await goFixture();
  cleanups.push(f.dispose);
  await measureFixture("format.go.prepare", () => f.prepare());
  expect(await goLintAdapter.verify(await f.checkContext())).toBe(true);
  const before = await f.bytes();
  expect((await goLintAdapter.check(await f.checkContext())).map((c) => c.status)).toEqual(["passed", "passed"]);
  expect(await f.bytes()).toEqual(before);
  await writeFile(join(f.root, "main.go"), "// Package main demonstrates lint.\npackage main\n\nfunc main(){}\n");
  const unformatted = await f.bytes();
  const checks = await goLintAdapter.check(await f.checkContext());
  expect(checks.map((c) => c.status)).toEqual(["passed", "failed"]);
  expect(checks[1]?.diagnostics.every((d) => ["gofumpt", "goimports"].includes(d.rule ?? ""))).toBe(true);
  expect(await f.bytes()).toEqual(unformatted);
  const context = await f.checkContext();
  const diff = await checkGoFormat(context, ["main.go"]);
  expect(diff.exit_code, diff.stderr).toBe(1);
  expect(diff.stdout).toContain("main.go");
  expect(await f.bytes()).toEqual(unformatted);
  const untouched = "package main\nfunc untouched(){}\n";
  await writeFile(join(f.root, "other.go"), untouched);
  assertFormatProcess(await formatGo(context, ["main.go"]), "golangci-lint");
  expect(await readFile(join(f.root, "other.go"), "utf8")).toBe(untouched);
  await unlink(join(f.root, "other.go"));
  expect((await goLintAdapter.check(context))[1]?.status).toBe("passed");
  const clean = await checkGoFormat(context, ["main.go"]);
  expect(clean.exit_code, clean.stderr).toBe(0);
  expect(clean.stdout).toBe("");
  const formatted = await f.bytes();
  assertFormatProcess(await formatGo(context, ["main.go"]), "golangci-lint");
  expect(await f.bytes()).toEqual(formatted);
}, 90000);

test("go.work resolves imported members while selected package scope excludes nested modules", async () => {
  const f = await goFixture(true);
  cleanups.push(f.dispose);
  await f.prepare();
  await writeFile(
    join(f.root, "main.go"),
    '// Package main demonstrates lint.\npackage main\n\nimport "example.test/child"\n\nfunc main() { println(child.Value) }\n',
  );
  await writeFile(
    join(f.root, "child/child.go"),
    '// Package child exposes a value.\npackage child\n\nimport "os"\n\n// Value is a value.\nconst Value = 1\n\n// Unsafe demonstrates an issue.\nfunc Unsafe() { os.WriteFile("out", nil, 0o777) }\n',
  );
  const before = await f.bytes();
  const root = await goLintAdapter.check(await f.checkContext());
  expect(root[0]?.status, JSON.stringify(root)).toBe("passed");
  expect(root.flatMap((c) => c.diagnostics).some((d) => d.path?.startsWith("child/"))).toBe(false);
  const child = await goLintAdapter.check(await f.checkContext(1));
  expect(
    child[0]?.diagnostics.some(
      (d) => d.rule === "errcheck" && d.path === "child/child.go" && d.project_path === "child.go",
    ),
  ).toBe(true);
  expect(await f.bytes()).toEqual(before);
  await writeFile(join(f.root, "go.work"), "go 1.25\nuse .\nreplace example.test/child => ./child\n");
  await writeFile(join(f.root, "go.mod"), "module example.test/app\ngo 1.25\nrequire example.test/child v0.0.0\n");
  const replaced = await f.bytes();
  const localReplacement = await goLintAdapter.check(await f.checkContext());
  expect(localReplacement[0]?.status, JSON.stringify(localReplacement)).toBe("passed");
  expect(await f.bytes()).toEqual(replaced);
}, 90000);
test("missing module cache is a readiness failure and check does not fetch or write sums", async () => {
  const f = await goFixture();
  cleanups.push(f.dispose);
  await f.prepare();
  await writeFile(join(f.root, "go.mod"), "module example.test/app\ngo 1.25\nrequire example.test/not-cached v1.0.0\n");
  await writeFile(
    join(f.root, "main.go"),
    '// Package main demonstrates lint.\npackage main\nimport _ "example.test/not-cached"\nfunc main() {}\n',
  );
  const before = await f.bytes();
  const checks = await goLintAdapter.check(await f.checkContext());
  expect(checks.every((c) => c.status === "not-run" && c.reason?.includes("dependency_sync"))).toBe(true);
  expect(await f.bytes()).toEqual(before);
});
test("absent manager and incompatible Go fail before publication", async () => {
  const f = await goFixture();
  cleanups.push(f.dispose);
  const target = (await f.checkContext()).target;
  const path = target.scope.env.PATH;
  target.scope.env.PATH = "";
  await expect(goLintAdapter.preflight(f.context)).rejects.toThrow("not installed");
  target.scope.env.PATH = path;
  await writeFile(join(f.root, "go.mod"), "module example.test/app\ngo 1.99\n");
  await expect(goLintAdapter.preflight(f.context)).rejects.toThrow("requires Go");
  expect(f.context.changes).toEqual([]);
});
test("native schema failure and corrupt installed binary remain explicit", async () => {
  const f = await goFixture();
  cleanups.push(f.dispose);
  await f.prepare();
  const ctx = await f.checkContext();
  await writeFile(ctx.projection.configs.lint, "version: '2'\nunknown-option: 1\n");
  expect(await goLintAdapter.verify(ctx)).toBe(false);
  const projected = ctx.projection.files[0];
  if (!projected) {
    throw new Error("missing projection");
  }
  await writeFile(ctx.projection.configs.lint, projected.content);
  await writeFile(golangciPath(f.root, GO_LINT_VERSION), "broken");
  expect(await goLintAdapter.verify(ctx)).toBe(false);
}, 90000);
test("workspace checksum completion stays in a transient workspace and preserves original metadata", async () => {
  const f = await goFixture(true);
  cleanups.push(f.dispose);
  await f.prepare();
  const proxy = join(f.root, ".cache/proxy"),
    seed = join(f.root, ".cache/seed");
  await createGoProxy(proxy);
  await mkdir(seed, { recursive: true });
  await writeFile(join(seed, "go.mod"), "module example.test/seed\ngo 1.25\nrequire example.test/lib v1.0.0\n");
  const target = (await f.checkContext()).target;
  target.scope.env.GOMODCACHE = join(f.root, ".cache/modules");
  const downloaded = await runProcess(Bun.which("go") ?? "go", ["mod", "download", "all"], {
    cwd: seed,
    env: {
      ...target.scope.env,
      GOWORK: "off",
      GOPROXY: `file://${proxy}`,
      GOSUMDB: "off",
      GOTOOLCHAIN: "local",
      GOFLAGS: "",
    },
  });
  expect(downloaded.exit_code, downloaded.stderr).toBe(0);
  await writeFile(join(f.root, "go.mod"), "module example.test/app\ngo 1.25\nrequire example.test/lib v1.0.0\n");
  await writeFile(
    join(f.root, "main.go"),
    '// Package main demonstrates lint.\npackage main\n\nimport _ "example.test/lib"\n\nfunc main() {}\n',
  );
  const before = await f.bytes();
  const native = await lintManagerContext(target, f.context.signal);
  let scratch = "";
  const checked = await goLintAdapter.check(await f.checkContext());
  expect(
    checked.every((c) => c.status === "passed"),
    JSON.stringify(checked),
  ).toBe(true);
  expect(await f.bytes()).toEqual(before);
  await expect(
    withGoEnvironment(target, native, (env) => {
      return suppliedResponse(() => {
        scratch = (env as Partial<typeof env>).GOWORK ?? "";
        throw new Error("cancelled fixture operation");
      });
    }),
  ).rejects.toThrow("cancelled");
  await expect(access(scratch)).rejects.toThrow();
  expect(await f.bytes()).toEqual(before);
}, 90000);
test("native runner lock contention is reported and the external lock is left intact", async () => {
  const f = await goFixture();
  cleanups.push(f.dispose);
  await f.prepare();
  const temp = join(f.root, ".cache/native-tmp");
  await mkdir(temp, { recursive: true });
  const target = (await f.checkContext()).target;
  target.scope.env.TMPDIR = temp;
  const path = join(temp, "golangci-lint.lock");
  const holder = spawn(
    "/usr/bin/python3",
    [
      "-c",
      "import fcntl,sys\nf=open(sys.argv[1],'w')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('ready',flush=True)\nsys.stdin.read()",
      path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once("data", () => resolve());
      holder.once("error", reject);
      holder.once("exit", () => reject(new Error("fixture lock holder exited")));
    });
    const identity = (await stat(path)).ino;
    const checks = await goLintAdapter.check(await f.checkContext());
    expect(
      checks.every((c) => c.status === "not-run" && c.reason?.includes("parallel golangci-lint")),
      JSON.stringify(checks),
    ).toBe(true);
    expect((await stat(path)).ino).toBe(identity);
  } finally {
    holder.stdin.end();
    await new Promise<void>((resolve) => holder.once("close", () => resolve()));
  }
}, 90000);
test("native type-analysis failure cannot mark a lint stage complete", async () => {
  const f = await goFixture();
  cleanups.push(f.dispose);
  await f.prepare();
  await writeFile(
    join(f.root, "main.go"),
    "// Package main demonstrates lint.\npackage main\n\nfunc main() { missing() }\n",
  );
  const failed = await goLintAdapter.check(await f.checkContext());
  expect(
    failed.every((c) => c.status === "not-run"),
    JSON.stringify(failed),
  ).toBe(true);
  expect(failed[0]?.diagnostics.some((d) => d.rule === "typecheck")).toBe(true);
}, 90000);
test("a binary built with older Go is rejected before executable publication", async () => {
  const f = await goFixture();
  cleanups.push(f.dispose);
  await writeFile(join(f.root, "go.mod"), "module example.test/app\ngo 1.99\n");
  const transport = artifactTransport(await officialArchive());
  try {
    await expect(goLintAdapter.prepareBatch(f.context)).rejects.toThrow("cannot analyze required Go");
  } finally {
    transport.mockRestore();
  }
  await expect(access(golangciPath(f.root, GO_LINT_VERSION))).rejects.toThrow();
  expect(f.context.changes).toEqual([]);
});
