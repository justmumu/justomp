import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./npm-pnpm-fixture";

test("npm/pnpm fixture rejects a launcher whose measured version differs from the tested manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-manager-version-"));
  const previous = process.env.JUSTOMP_PNPM_BINARY;
  let created: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const binary = join(root, "pnpm");
    await writeFile(binary, '#!/bin/sh\nprintf "0.0.0\\n"\n');
    await chmod(binary, 0o755);
    process.env.JUSTOMP_PNPM_BINARY = binary;
    await expect(
      fixture("pnpm").then((value) => {
        created = value;
      }),
    ).rejects.toThrow("Native pnpm test requires");
  } finally {
    if (previous === undefined) delete process.env.JUSTOMP_PNPM_BINARY;
    else process.env.JUSTOMP_PNPM_BINARY = previous;
    await created?.close();
    await rm(root, { recursive: true, force: true });
  }
});
