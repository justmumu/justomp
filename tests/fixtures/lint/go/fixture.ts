import { spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLintConfig } from "../../../../src/config/lint/resolve";
import { goLintAdapter } from "../../../../src/lint/adapters/go";
import { type LintOperationContext } from "../../../../src/lint/adapters/types";
import { golangciArtifact } from "../../../../src/lint/go/install";
import { applyProjection, planProjection } from "../../../../src/lint/projection";
import { resolveLintTarget } from "../../../../src/lint/targets";
import { closePackagingStructure, getPackagingStructure } from "../../../../src/packaging/get-structure";
import { suppliedResponse } from "../../../response";

export const GO_LINT_VERSION = "2.15.0";
export async function officialArchive(): Promise<Buffer> {
  const override = process.env.JUSTOMP_GOLANGCI_ARCHIVE;
  if (override) {
    return readFile(override);
  }
  const artifact = golangciArtifact(GO_LINT_VERSION);
  const cache = join(tmpdir(), "justomp-go-lint-native", artifact.archive);
  try {
    return await readFile(cache);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const response = await fetch(`${artifact.base}/${artifact.archive}`);
  if (!response.ok) {
    throw new Error(`Official Go lint fixture download failed: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const checksums = await fetch(`${artifact.base}/golangci-lint-${GO_LINT_VERSION}-checksums.txt`);
  if (
    !checksums.ok ||
    !(await checksums.text()).includes(`${createHash("sha256").update(bytes).digest("hex")}  ${artifact.archive}`)
  ) {
    throw new Error("Official Go lint fixture checksum mismatch");
  }
  await mkdir(join(tmpdir(), "justomp-go-lint-native"), { recursive: true });
  await writeFile(cache, bytes);
  return bytes;
}
export function artifactTransport(bytes: Buffer, checksum = createHash("sha256").update(bytes).digest("hex")) {
  const artifact = golangciArtifact(GO_LINT_VERSION),
    original = globalThis.fetch;
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        return suppliedResponse(() => {
          const url = String(input);
          if (url.endsWith("/releases/latest")) {
            return Response.json({
              tag_name: `v${GO_LINT_VERSION}`,
              draft: false,
              prerelease: false,
            });
          }
          if (url.endsWith("checksums.txt")) {
            return new Response(`${checksum}  ${artifact.archive}\n`);
          }
          if (url.endsWith(artifact.archive)) {
            return new Response(new Uint8Array(bytes));
          }
          throw new Error(`Unexpected network request: ${url}`);
        });
      },
      { preconnect: original.preconnect },
    ),
  );
}
export async function goFixture(workspace = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lint-go-")));
  await writeFile(join(root, "go.mod"), "module example.test/app\n\ngo 1.25\n");
  await writeFile(join(root, "main.go"), "// Package main demonstrates lint.\npackage main\n\nfunc main() {}\n");
  if (workspace) {
    await mkdir(join(root, "child"));
    await writeFile(join(root, "child/go.mod"), "module example.test/child\n\ngo 1.25\n");
    await writeFile(
      join(root, "child/child.go"),
      "// Package child exposes a value.\npackage child\n\n// Value is a value.\nconst Value = 1\n",
    );
    await writeFile(join(root, "go.work"), "go 1.25\n\nuse (\n .\n ./child\n)\n");
  }
  const { structure } = await getPackagingStructure(root, { publish: false });
  const targets = await Promise.all(
    structure.projects
      .toSorted((a, b) => (a.path === "." ? -1 : b.path === "." ? 1 : a.path.localeCompare(b.path)))
      .map((project) => resolveLintTarget(structure, project.project_id)),
  );
  const signal = new AbortController().signal,
    policy = resolveLintConfig().policy;
  const context: LintOperationContext = {
    targets,
    policy,
    signal,
    versions: Object.fromEntries(
      targets.map((target) => [target.project.project_id, { "golangci-lint": GO_LINT_VERSION }]),
    ),
    changes: [],
  };
  const checkContext = async (index = 0) => {
    const target = targets[index];
    if (!target) {
      throw new Error("Missing fixture target");
    }
    return {
      target,
      policy,
      signal,
      versions: context.versions[target.project.project_id] ?? {},
      projection: await planProjection(target, policy),
    };
  };
  return {
    root,
    targets,
    context,
    checkContext,
    async prepare() {
      const transport = artifactTransport(await officialArchive());
      try {
        await goLintAdapter.preflight(context);
        await goLintAdapter.prepareBatch(context);
        for (const target of targets) {
          await applyProjection(await planProjection(target, policy), context.changes);
        }
      } finally {
        transport.mockRestore();
      }
    },
    async bytes() {
      const result: Record<string, string> = {};
      await visit(root, "", result);
      return result;
    },
    async dispose() {
      await closePackagingStructure(root);
      async function writable(path: string) {
        await chmod(path, 0o755);
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await writable(join(path, entry.name));
          }
        }
      }
      await writable(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function visit(root: string, directory: string, result: Record<string, string>) {
  for (const entry of await readdir(join(root, directory), {
    withFileTypes: true,
  })) {
    if ([".justomp", ".cache"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(root, path, result);
    } else if (entry.isFile()) {
      result[path] = createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex");
    }
  }
}
