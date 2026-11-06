import { spyOn } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LintResult } from "../../../src/lint/model";
import { ruffArtifact } from "../../../src/lint/ruff-install";
import { closePackagingStructure } from "../../../src/packaging/get-structure";
import { pythonFixture } from "../../fixtures/lint/python/fixture";
import { VERSION as PYRIGHT_VERSION } from "../../fixtures/typecheck/python/fixture";
import { suppliedResponse } from "../../response";
import { createHost } from "./host";
import { createLocalHost, localPythonCheckers } from "./local-checkers";
export const cleanups: (() => Promise<void>)[] = [];
export async function fixture(deny: string[] = [], local = false, nativeLint = false) {
  if (local) {
    const restore = localPythonCheckers(nativeLint);
    cleanups.push(async () => restore());
  }
  const f = await pythonFixture();
  cleanups.push(async () => {
    await closePackagingStructure(f.root);
    await f.dispose();
  });
  await writeFile(join(f.root, "module.py"), '"""Example module."""\n');
  const h = local ? await createLocalHost(f.root, deny) : await createHost(f.root, undefined, deny);
  cleanups.push(h.close);
  return { f, h };
}
export function registry() {
  const original = globalThis.fetch;
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input) === "https://pypi.org/pypi/pyright/json") {
          return suppliedResponse(() => Response.json({ releases: { [PYRIGHT_VERSION]: [{ yanked: false }] } }));
        }
        const artifact = ruffArtifact();
        if (![artifact.archive, artifact.checksums].some((file) => String(input) === `${artifact.base}/${file}`)) {
          throw new Error(`Unexpected network: ${input}`);
        }
        return original(input, init);
      },
      { preconnect: original.preconnect },
    ),
  );
}
export function json<T = LintResult>(result: { content: unknown }) {
  return JSON.parse(
    (result.content as { type: string; text: string }[])
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n"),
  ) as T;
}
export async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await Bun.sleep(15);
  }
}
export function heldRegistry() {
  const original = globalThis.fetch;
  let release = () => {
    /* This supplied callback intentionally has no side effects. */
  };
  let entered = false;
  let calls = 0;
  let aborted = false;
  const artifact = ruffArtifact();
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input) === "https://pypi.org/pypi/pyright/json") {
          return Response.json({
            releases: { [PYRIGHT_VERSION]: [{ yanked: false }] },
          });
        }
        if (![artifact.archive, artifact.checksums].some((file) => String(input) === `${artifact.base}/${file}`)) {
          throw new Error(`Unexpected network ${input}`);
        }
        if (String(input) !== `${artifact.base}/${artifact.checksums}`) {
          return original(input, init);
        }
        calls++;
        entered = true;
        const signal = init?.signal;
        let abort = () => {
          /* This supplied callback intentionally has no side effects. */
        };
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => {
            aborted = true;
            reject(signal?.reason);
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) {
            abort();
          }
        });
        try {
          await Promise.race([gate, cancelled]);
        } finally {
          signal?.removeEventListener("abort", abort);
        }
        return original(input, init);
      },
      { preconnect: original.preconnect },
    ),
  );
  return { fetcher, release, entered: () => entered, calls: () => calls, aborted: () => aborted };
}
