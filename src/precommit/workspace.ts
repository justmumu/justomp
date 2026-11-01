import { posix } from "node:path";
import picomatch from "picomatch";
import type { WorkspaceDeclaration } from "../inspect/model";

/** A workspace member may equal a gitlink or live inside it. A gitlink inside
 * an ordinary member is not itself a member of that workspace. */
export function workspaceIncludesGitlink(
  declaration: Pick<WorkspaceDeclaration, "kind" | "includes" | "excludes">,
  path: string,
): boolean {
  const member = posix.normalize(path);
  const dot = declaration.kind === "uv" || declaration.kind === "go";
  const excluded = (value: string) =>
    declaration.excludes.some((pattern) =>
      picomatch(posix.normalize(pattern), { dot })(value),
    );
  if (excluded(member)) return false;
  return declaration.includes.some((raw) => {
    const pattern = posix.normalize(raw);
    if (declaration.kind === "go" || !pattern.includes("*"))
      return (
        !excluded(pattern) &&
        (pattern === member || pattern.startsWith(`${member}/`))
      );
    const parts = pattern.split("/");
    const dirs = member === "." ? [] : member.split("/");
    const memo = new Map<string, boolean>();
    const match = (i: number, j: number): boolean => {
      if (j === dirs.length) return true;
      if (i === parts.length) return false;
      const key = `${i}:${j}`;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      const part = parts[i] as string;
      const dir = dirs[j] as string;
      const result =
        part === "**"
          ? match(i + 1, j) ||
            ((dot || !dir.startsWith(".")) && match(i, j + 1))
          : picomatch(part, { dot })(dir) && match(i + 1, j + 1);
      memo.set(key, result);
      return result;
    };
    return match(0, 0);
  });
}
