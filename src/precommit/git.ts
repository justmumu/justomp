import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "../dependencies/runner";

export interface GitContext {
  root: string;
  gitDirectory: string;
  commonDirectory: string;
  index: string;
  hooks: string;
  signal?: AbortSignal;
}
export async function git(cwd: string, args: string[], signal?: AbortSignal) {
  return runProcess("git", args, {
    cwd,
    ...(signal ? { signal } : {}),
    limit: 16 * 1024 * 1024,
  });
}
export async function gitText(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await git(cwd, args, signal);
  if (result.exit_code !== 0 || result.cancelled || result.truncated) {
    throw new Error(`Git ${args[0]} failed: ${result.stderr || "incomplete output"}`);
  }
  return result.stdout;
}
export async function gitContext(cwd: string, signal?: AbortSignal): Promise<GitContext | null> {
  const probe = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
  if (probe.cancelled || probe.truncated) {
    throw new Error("Git discovery incomplete");
  }
  if (probe.exit_code !== 0) {
    if (probe.stderr.includes("not a git repository")) {
      return null;
    }
    throw new Error(probe.stderr);
  }
  const root = await realpath(probe.stdout.replace(/\n$/, ""));
  const path = async (args: string[]) =>
    resolve(root, (await gitText(root, ["rev-parse", ...args], signal)).replace(/\n$/, ""));
  return {
    root,
    gitDirectory: await path(["--absolute-git-dir"]),
    commonDirectory: await path(["--git-common-dir"]),
    index: await path(["--git-path", "index"]),
    hooks: await path(["--git-path", "hooks"]),
    ...(signal ? { signal } : {}),
  };
}
export interface StagedRecord {
  status: string;
  paths: string[];
}
export function parseStagedRecords(text: string): StagedRecord[] {
  if (!text) {
    return [];
  }
  if (!text.endsWith("\0")) {
    throw new Error("Incomplete Git index records");
  }
  const fields = text.slice(0, -1).split("\0"),
    records: StagedRecord[] = [];
  let cursor = 0;
  while (cursor < fields.length) {
    const status = fields[cursor++] ?? "";
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) {
      throw new Error("Invalid Git status record");
    }
    const count = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields.slice(cursor, cursor + count);
    cursor += count;
    if (paths.length !== count || paths.some((p) => !p)) {
      throw new Error("Incomplete Git index paths");
    }
    records.push({ status, paths });
  }
  return records;
}
export async function stagedRecords(context: GitContext) {
  return parseStagedRecords(
    await gitText(
      context.root,
      ["diff", "--cached", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--"],
      context.signal,
    ),
  );
}
export async function gitlinks(context: GitContext): Promise<string[]> {
  const text = await gitText(context.root, ["ls-files", "--stage", "-z"], context.signal);
  return text
    .split("\0")
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1));
}
