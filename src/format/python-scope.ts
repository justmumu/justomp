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
function glob(pattern: string): RegExp {
  const bytes = Buffer.from(pattern).toString("latin1");
  let source = "";
  let alternate = false;
  for (let i = 0; i < bytes.length; i++) {
    const char = bytes[i];
    if (char === "\\") {
      const next = bytes[++i];
      if (next === undefined) {
        unsupported(`trailing escape in Ruff exclusion ${JSON.stringify(pattern)}`);
      }
      source += literal(next);
    } else if (char === "*") {
      if (bytes[i + 1] === "*") {
        const before = bytes[i - 1];
        const after = bytes[i + 2];
        if ((before !== undefined && before !== "/") || (after !== undefined && after !== "/")) {
          unsupported(`non-segment ** in Ruff exclusion ${JSON.stringify(pattern)}`);
        }
        i++;
        if (after === "/") {
          source += "(?:[\\s\\S]*/)?";
          i++;
          continue;
        }
      }
      source += "[\\s\\S]*";
    } else if (char === "?") {
      source += "[\\s\\S]";
    } else if (char === "[") {
      const start = i + 1;
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
      let body = bytes.slice(start, end);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) {
        body = body.slice(1);
      }
      if (body.includes("\\") || (body.includes("[") && body !== "[")) {
        unsupported(`unsupported class in Ruff exclusion ${JSON.stringify(pattern)}`);
      }
      source += `[${negate ? "^" : ""}${body.replace(/[[\]^]/g, "\\$&")}]`;
      i = end;
    } else if (char === "{") {
      if (alternate) {
        unsupported(`nested alternatives in Ruff exclusion ${JSON.stringify(pattern)}`);
      }
      alternate = true;
      source += "(?:";
    } else if (char === "}") {
      if (!alternate || bytes[i - 1] === "," || bytes[i - 1] === "{") {
        unsupported(`invalid alternatives in Ruff exclusion ${JSON.stringify(pattern)}`);
      }
      alternate = false;
      source += ")";
    } else if (char === "," && alternate) {
      if (bytes[i - 1] === "{" || bytes[i - 1] === ",") {
        unsupported(`empty alternative in Ruff exclusion ${JSON.stringify(pattern)}`);
      }
      source += "|";
    } else {
      source += literal(char ?? "");
    }
  }
  if (alternate) {
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
      for (let current = absolute; ; current = dirname(current)) {
        if (excluded(current) || extended(current)) {
          return false;
        }
        if (current === cwd || dirname(current) === current) {
          return true;
        }
      }
    }),
  };
}
