import { basename, dirname, resolve } from "node:path";
import { type PythonPolicy } from "../config/lint/model";
import { FormatError, type FormatScope } from "./model";
import { formatterFor } from "./selection";

function unsupported(message: string): never {
  throw new FormatError("unsupported-config", `Cannot select Python format files: ${message}`);
}
function literal(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
/** Ruff's globset matches UTF-8 bytes, with * and ? also crossing separators.
 * Only exclusion syntax is interpreted here; no config discovery or ignore walker.
 * https://docs.rs/globset/latest/globset/#syntax
 */
interface GlobCursor {
  bytes: string;
  pattern: string;
  index: number;
  alternate: boolean;
}
function globStar(cursor: GlobCursor): string {
  const { bytes, index, pattern } = cursor;
  if (bytes[index + 1] !== "*") {
    return "[\\s\\S]*";
  }
  const before = bytes[index - 1];
  const after = bytes[index + 2];
  if ((before !== undefined && before !== "/") || (after !== undefined && after !== "/")) {
    unsupported(`non-segment ** in Ruff exclusion ${JSON.stringify(pattern)}`);
  }
  cursor.index++;
  if (after === "/") {
    cursor.index++;
    return "(?:[\\s\\S]*/)?";
  }
  return "[\\s\\S]*";
}
function classSource(body: string, pattern: string): string {
  const negate = body.startsWith("!") || body.startsWith("^");
  if (negate) {
    body = body.slice(1);
  }
  if (body.includes("\\") || (body.includes("[") && body !== "[")) {
    unsupported(`unsupported class in Ruff exclusion ${JSON.stringify(pattern)}`);
  }
  return `[${negate ? "^" : ""}${body.replace(/[[\]^]/g, "\\$&")}]`;
}
function globClass(cursor: GlobCursor): string {
  const { bytes, pattern } = cursor;
  const start = cursor.index + 1;
  let end = start;
  if (bytes[end] === "!" || bytes[end] === "^") {
    end++;
  }
  if (bytes[end] === "]") {
    end++;
  }
  while (end < bytes.length && bytes[end] !== "]") {
    end++;
  }
  if (end === bytes.length) {
    unsupported(`unclosed class in Ruff exclusion ${JSON.stringify(pattern)}`);
  }
  cursor.index = end;
  return classSource(bytes.slice(start, end), pattern);
}
function globAlternative(cursor: GlobCursor, char: "{" | "}" | ","): string {
  const { bytes, index, pattern, alternate } = cursor;
  if (char === "{") {
    if (alternate) {
      unsupported(`nested alternatives in Ruff exclusion ${JSON.stringify(pattern)}`);
    }
    cursor.alternate = true;
    return "(?:";
  }
  if (char === "}") {
    if (!alternate || bytes[index - 1] === "," || bytes[index - 1] === "{") {
      unsupported(`invalid alternatives in Ruff exclusion ${JSON.stringify(pattern)}`);
    }
    cursor.alternate = false;
    return ")";
  }
  if (!alternate) {
    return literal(char);
  }
  if (bytes[index - 1] === "{" || bytes[index - 1] === ",") {
    unsupported(`empty alternative in Ruff exclusion ${JSON.stringify(pattern)}`);
  }
  return "|";
}
function globToken(cursor: GlobCursor): string {
  const char = cursor.bytes[cursor.index];
  switch (char) {
    case "\\": {
      const next = cursor.bytes[++cursor.index];
      if (next === undefined) {
        unsupported(`trailing escape in Ruff exclusion ${JSON.stringify(cursor.pattern)}`);
      }
      return literal(next);
    }
    case "*":
      return globStar(cursor);
    case "?":
      return "[\\s\\S]";
    case "[":
      return globClass(cursor);
    case "{":
    case "}":
    case ",":
      return globAlternative(cursor, char);
    default:
      return literal(char ?? "");
  }
}
function glob(pattern: string): RegExp {
  const cursor: GlobCursor = { bytes: Buffer.from(pattern).toString("latin1"), pattern, index: 0, alternate: false };
  let source = "";
  for (; cursor.index < cursor.bytes.length; cursor.index++) {
    source += globToken(cursor);
  }
  if (cursor.alternate) {
    unsupported(`unclosed alternatives in Ruff exclusion ${JSON.stringify(pattern)}`);
  }
  try {
    return new RegExp(`^(?:${source})(?![\\s\\S])`);
  } catch {
    return unsupported(`invalid Ruff exclusion ${JSON.stringify(pattern)}`);
  }
}
function patterns(value: unknown, field: string, cwd: string): (path: string) => boolean {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    unsupported(`lint.python.ruff.${field} must be an array of strings`);
  }
  // Escape the literal root before normalizing globs, just as Ruff's GlobPath does.
  const root = cwd.replace(/[\\*?{}[\]]/g, "\\$&");
  const compiled = (value as string[]).flatMap((pattern) => [
    glob(resolve(root, pattern)),
    ...(!pattern.includes("/") ? [glob(pattern)] : []),
  ]);
  return (path) => {
    const full = Buffer.from(path).toString("latin1");
    const name = Buffer.from(basename(path)).toString("latin1");
    return compiled.some((pattern) => pattern.test(full) || pattern.test(name));
  };
}

function ancestorsIncluded(
  absolute: string,
  cwd: string,
  excluded: (path: string) => boolean,
  extended: (path: string) => boolean,
): boolean {
  for (let current = absolute; ; current = dirname(current)) {
    if (excluded(current) || extended(current)) {
      return false;
    }
    if (current === cwd || dirname(current) === current) {
      return true;
    }
  }
}
/** Match the exact filename invocation used by formatPython, including force-exclude.
 * Ruff's top-level exclusions check ancestors; format.exclude checks the file only.
 * Explicit files bypass include and gitignore discovery, so neither is reproduced.
 */
export function filterPythonFormatScope(
  scope: FormatScope,
  cwd: string,
  policy: PythonPolicy,
  requestedFiles?: readonly string[],
): FormatScope {
  const requested = requestedFiles && new Set(requestedFiles);
  const files = scope.files.filter((path) => !requested || requested.has(path));
  if (!files.some((path) => formatterFor(path, scope.ecosystem)?.engine === "ruff")) {
    return { ...scope, files };
  }
  if (policy.ruff.extend !== undefined) {
    unsupported("Ruff extend is unsupported; put inherited exclusions directly in lint.python.ruff");
  }
  const excluded = patterns(policy.ruff.exclude, "exclude", cwd);
  const extended = patterns(policy.ruff["extend-exclude"], "extend-exclude", cwd);
  const formatted = patterns(
    policy.ruff.format.exclude === undefined ? [] : policy.ruff.format.exclude,
    "format.exclude",
    cwd,
  );
  return {
    ...scope,
    files: files.filter((path) => {
      if (formatterFor(path, scope.ecosystem)?.engine !== "ruff") {
        return true;
      }
      const absolute = resolve(cwd, path);
      if (formatted(absolute)) {
        return false;
      }
      return ancestorsIncluded(absolute, cwd, excluded, extended);
    }),
  };
}
