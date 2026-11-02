import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "./host";
export const roots: string[] = [];
export const hosts: Awaited<ReturnType<typeof createHost>>[] = [];
export async function fixture(empty = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-tools-")));
  roots.push(root);
  await writeFile(
    join(root, ".npmrc"),
    `cache=${join(root, ".npm-cache")}\naudit=false\nfund=false\nignore-scripts=false\n`,
  );
  if (!empty) {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "tool-fixture",
        private: true,
        packageManager: "npm@11.12.1",
      }),
    );
  }
  return root;
}
export async function host(root: string, deny: string[] = []) {
  const h = await createHost(root, undefined, deny);
  hosts.push(h);
  return h;
}
export function json(result: { content: { type: string; text?: string }[] }) {
  const text = result.content.findLast((part) => part.type === "text")?.text;
  return JSON.parse(text ?? "null");
}
export async function lockFixture(root: string) {
  const child = Bun.spawn(["npm", "install", "--package-lock-only", "--ignore-scripts"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`Fixture lock failed: ${output} ${error}`);
  }
}
export async function blockingFixture() {
  const root = await fixture();
  await lockFixture(root);
  await writeFile(
    join(root, "hold.cjs"),
    `const fs = require('node:fs'); fs.writeFileSync('started', String(process.pid)); process.on('SIGTERM', () => { fs.writeFileSync('stopped', 'yes'); process.exit(0); }); setInterval(() => {}, 1000);`,
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "blocking",
      private: true,
      packageManager: "npm@11.12.1",
      scripts: { preinstall: "node hold.cjs" },
    }),
  );
  return root;
}
export async function waitStarted(root: string) {
  const started = join(root, "started");
  const deadline = Date.now() + 10_000;
  while (!(await Bun.file(started).exists())) {
    if (Date.now() > deadline) {
      throw new Error("Native lifecycle process did not start");
    }
    await Bun.sleep(20);
  }
  return Number(await readFile(started, "utf8"));
}
