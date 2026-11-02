import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { checkProjectTypecheck, prepareProjectTypecheck } from "../../../src/typecheck/index";
import { generatedFixture } from "../../fixtures/typecheck/generated/fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});
async function fixture() {
  const f = await generatedFixture(true);
  cleanups.push(f.dispose);
  await f.write(
    "app/layout.tsx",
    "export default function Layout({children}: {children: React.ReactNode}) {return <html><body>{children}</body></html>}\n",
  );
  await f.write("app/page.tsx", "export default function Page() {return <main>Hello</main>}\n");
  await f.write("app/api/route.ts", "export function GET() {return 123;}\n");
  await f.write("config/typescript.json", {
    compilerOptions: {
      jsx: "preserve",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    include: ["../app/**/*.ts", "../app/**/*.tsx"],
  });
  await f.write(
    "next.config.mjs",
    'export default {distDir:"generated-next", typescript:{tsconfigPath:"config/typescript.json"}};\n',
  );
  await f.install();
  await f.ready("javascript:package.json");
  return f;
}
test("public Next preparation generates custom-path route types consumed by the selected checker", async () => {
  const f = await fixture(),
    dist = "generated-next";
  expect((await checkProjectTypecheck(f.root, "javascript:package.json")).complete).toBe(false);
  expect(await Bun.file(join(f.root, dist, "types/validator.ts")).exists()).toBe(false);
  const prepared = await prepareProjectTypecheck(f.root, "javascript:package.json");
  expect(prepared.errors).toEqual([]);
  expect(prepared.complete).toBe(true);
  const result = await checkProjectTypecheck(f.root, "javascript:package.json");
  expect(result.complete).toBe(true);
  expect(result.checks[0]?.status).toBe("failed");
  expect(result.diagnostics.some((d) => d.path?.includes("types/validator.ts"))).toBe(true);
  expect(prepared.changes.some((change) => change.path === "next-env.d.ts")).toBe(true);
  expect(prepared.changes.some((change) => change.path.endsWith("types/validator.ts"))).toBe(true);
}, 180000);
