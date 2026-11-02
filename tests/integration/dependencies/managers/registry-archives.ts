import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyArchivePayloads } from "../../../fixtures/dependencies/archive-payload";

const payloads = new Map<string, Promise<ReadonlyMap<string, Uint8Array>>>();
/** Only immutable archive bytes are shared. Every registry keeps its own published versions. */
export async function registryArchives(kind: "npm" | "yarn") {
  let result = payloads.get(kind);
  if (!result) {
    result = buildArchives(kind);
    payloads.set(kind, result);
  }
  return copyArchivePayloads(await result);
}
async function buildArchives(kind: "npm" | "yarn"): Promise<ReadonlyMap<string, Uint8Array>> {
  const root = await mkdtemp(join(tmpdir(), "justomp-registry-payloads-"));
  const archives = new Map<string, Uint8Array>();
  const names = kind === "npm" ? ["fixture-dep", "fixture-child"] : ["u6-dep", "u6-child", "u6-other"];
  try {
    for (const name of names) {
      for (const version of ["1.0.0", "1.1.0", "2.0.0"]) {
        const dir = join(root, `${name}-${version}`);
        await mkdir(join(dir, "package"), { recursive: true });
        await writeFile(
          join(dir, "package/package.json"),
          JSON.stringify({
            name,
            version,
            ...(kind === "yarn" ? { main: "index.js" } : {}),
            ...(name.endsWith("-dep")
              ? {
                  dependencies: {
                    [kind === "npm" ? "fixture-child" : "u6-child"]: "1.0.0",
                  },
                }
              : {}),
          }),
        );
        const files = ["package/package.json"];
        if (kind === "yarn") {
          await writeFile(join(dir, "package/index.js"), `module.exports=${JSON.stringify(version)};`);
          files.push("package/index.js");
        }
        const result = spawnSync("tar", ["-czf", "-", ...files], { cwd: dir });
        if (result.status !== 0) {
          throw new Error(`Fixture tar failed: ${result.stderr.toString()}`);
        }
        archives.set(`${name}-${version}.tgz`, result.stdout);
      }
    }
    return archives;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
