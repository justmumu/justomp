import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readOptional } from "../../dependencies/executable";
import { type AdapterContext, redact } from "../../dependencies/model";
import { safePath } from "../../dependencies/paths";
import { parseGo } from "../../inspect/readers/go";
import { LintError } from "../model";
import { type LintTarget } from "../targets";

export function readonlyGoEnvironment(target: LintTarget): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(target.scope.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOSUMDB: "off",
    GONOPROXY: "none",
    GOFLAGS: "-mod=readonly",
  };
}
/** Go's readonly mode still writes go.work.sum. A transient native workspace keeps original module scope without publishing those sums. */
export async function withGoEnvironment<T>(
  target: LintTarget,
  native: AdapterContext,
  operation: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const env = readonlyGoEnvironment(target);
  const work = env.GOWORK;
  if (!work || work === "off") {
    return operation(env);
  }
  await safePath(target.root, work);
  const source = await readFile(work, "utf8"),
    data = parseGo(source, "work");
  const args = ["work", "edit"];
  for (const path of data.uses) {
    args.push(`-dropuse=${path}`, `-use=${await safePath(target.root, resolve(dirname(work), path))}`);
  }
  // Native unversioned replacements remove versioned entries; restore specific entries afterward.
  for (const replacement of [...data.replaces].sort((a, b) => Number(!!a.version) - Number(!!b.version))) {
    const targetPath = replacement.targetVersion
      ? `${replacement.target}@${replacement.targetVersion}`
      : await safePath(target.root, resolve(dirname(work), replacement.target));
    args.push(`-replace=${replacement.name}${replacement.version ? `@${replacement.version}` : ""}=${targetPath}`);
  }
  args.push("-print", work);
  const rebased = await native.run({
    args,
    label: "Read native workspace with absolute member paths",
    env,
  });
  if (rebased.exit_code !== 0 || rebased.cancelled || rebased.truncated) {
    throw new LintError(
      "workspace-unavailable",
      redact(rebased.stderr || "Unable to prepare a readonly Go workspace view"),
    );
  }
  const scratch = await mkdtemp(join(tmpdir(), "justomp-go-work-"));
  try {
    const copy = join(scratch, "go.work");
    await writeFile(copy, rebased.stdout);
    await safePath(target.root, `${work}.sum`);
    const sums = await readOptional(`${work}.sum`);
    if (sums !== undefined) {
      await writeFile(`${copy}.sum`, sums);
    }
    return await operation({ ...env, GOWORK: copy });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
