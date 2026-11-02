import { link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export interface LargeTreeOptions {
  projects: number;
  entries: number;
  excludedEntries?: number;
}
export interface LargeTreeFixture {
  root: string;
  projects: number;
  includedEntries: number;
  excludedEntries: number;
  generatedEntries: number;
  directories: number;
  excludedDirectories: number;
  manifestBytes: number;
  sourceFiles: number;
  sourceLogicalBytes: number;
  firstManifest: string;
  cleanup: () => Promise<void>;
}
const SOURCE = 'export const fixture = "source contents must never be read by inspection";\n';
async function links(seed: string, directory: string, count: number, start: number, prefix: string): Promise<void> {
  for (let offset = start; offset < count; offset += 32) {
    const end = Math.min(count, offset + 32);
    await Promise.all(
      Array.from({ length: end - offset }, (_, index) =>
        link(seed, join(directory, `${prefix}-${String(offset + index).padStart(5, "0")}.ts`)),
      ),
    );
  }
}
/** Real entries with bounded construction IO; hardlinks keep content storage small. */
export async function createLargeTree(options: LargeTreeOptions): Promise<LargeTreeFixture> {
  const { projects, entries } = options;
  const excludedEntries = options.excludedEntries ?? 0;
  if (
    !Number.isInteger(projects) ||
    projects < 1 ||
    !Number.isInteger(entries) ||
    entries < projects * 2 ||
    !Number.isInteger(excludedEntries) ||
    excludedEntries < 0
  ) {
    throw new Error("Fixture requires positive projects, >=2 entries per project and nonnegative excluded entries");
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-benchmark-")));
  let manifestBytes = 0;
  let excludedDirectories = 0;
  try {
    const sourceFiles = entries - projects * 2;
    const each = Math.floor(sourceFiles / projects);
    const remainder = sourceFiles % projects;
    for (let index = 0; index < projects; index++) {
      manifestBytes += await createProject(root, index, projects, each + (index < remainder ? 1 : 0));
    }
    excludedDirectories = await createExcludedEntries(root, excludedEntries);
    return {
      root,
      projects,
      includedEntries: entries,
      excludedEntries,
      generatedEntries: entries + excludedEntries,
      directories: projects + 1 + excludedDirectories,
      excludedDirectories,
      manifestBytes,
      sourceFiles,
      sourceLogicalBytes: sourceFiles * Buffer.byteLength(SOURCE),
      firstManifest: join(root, "project-00000/package.json"),
      cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 2 }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 2 });
    throw error;
  }
}

async function createExcludedEntries(root: string, excludedEntries: number): Promise<number> {
  let excludedDirectories = 0;
  if (excludedEntries) {
    const dependency = join(root, "node_modules");
    await mkdir(dependency);
    excludedDirectories++;
    let remaining = excludedEntries - 1;
    let bucket = 0;
    while (remaining > 0) {
      const directory = join(dependency, `bucket-${bucket++}`);
      await mkdir(directory);
      excludedDirectories++;
      remaining--;
      const count = Math.min(1024, remaining);
      if (count) {
        const seed = join(directory, "dependency-00000.ts");
        await writeFile(seed, "");
        await links(seed, directory, count, 1, "dependency");
        remaining -= count;
      }
    }
  }

  return excludedDirectories;
}

async function createProject(root: string, index: number, projects: number, count: number): Promise<number> {
  const name = `project-${String(index).padStart(5, "0")}`;
  const directory = join(root, name);
  await mkdir(directory);
  const manifest = JSON.stringify({
    name,
    version: "1.0.0",
    ...(index % 2 === 0 && index + 1 < projects
      ? {
          dependencies: {
            [`project-${String(index + 1).padStart(5, "0")}`]: `file:../project-${String(index + 1).padStart(5, "0")}`,
          },
        }
      : {}),
  });
  await writeFile(join(directory, "package.json"), manifest);
  if (count) {
    const seed = join(directory, "source-00000.ts");
    await writeFile(seed, SOURCE);
    await links(seed, directory, count, 1, "source");
  }
  return Buffer.byteLength(manifest);
}
