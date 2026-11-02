import { afterEach, expect, spyOn, test } from "bun:test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { goLintAdapter } from "../../../src/lint/adapters/go";
import { golangciArtifact, golangciPath } from "../../../src/lint/go/install";
import { artifactTransport, GO_LINT_VERSION, goFixture } from "../../fixtures/lint/go/fixture";
import { cleanups } from "./go-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("checksum, interrupted download and archive paths cannot publish an executable", async () => {
  const f = await goFixture();
  cleanups.push(f.dispose);
  const bytes = Buffer.from("invalid checksum payload");
  let transport = artifactTransport(bytes, "0".repeat(64));
  try {
    await expect(goLintAdapter.prepareBatch(f.context)).rejects.toThrow("SHA-256");
  } finally {
    transport.mockRestore();
  }
  const path = golangciPath(f.root, GO_LINT_VERSION);
  await expect(access(path)).rejects.toThrow();
  const original = globalThis.fetch;
  const artifact = golangciArtifact(GO_LINT_VERSION);
  transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0]) => {
        if (String(url).endsWith("checksums.txt")) {
          return new Response(`${"0".repeat(64)}  ${artifact.archive}\n`);
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.error(new Error("interrupted fixture download"));
            },
          }),
        );
      },
      { preconnect: original.preconnect },
    ),
  );
  try {
    await expect(goLintAdapter.prepareBatch(f.context)).rejects.toThrow("interrupted");
  } finally {
    transport.mockRestore();
  }
  await expect(access(path)).rejects.toThrow();
  const bad = Buffer.from(await new Bun.Archive({ "../escaped-binary": "bad" }, { compress: "gzip" }).bytes());
  transport = artifactTransport(bad);
  try {
    await expect(goLintAdapter.prepareBatch(f.context)).rejects.toThrow("expected Go lint binary");
  } finally {
    transport.mockRestore();
  }
  expect(f.context.changes).toEqual([]);
  await expect(access(join(f.root, "escaped-binary"))).rejects.toThrow();
});
