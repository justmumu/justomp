import { type CoverageTotals, TestError } from "../model";
/** Multiple package invocations may instrument the same source; count each block once. */
export function goCoverage(profiles: string[], paths: ReadonlyMap<string, string>): CoverageTotals {
  const blocks = new Map<string, { statements: number; covered: boolean }>();
  let mode: string | undefined;
  if (!profiles.length) {
    throw new TestError("invalid-report", "Missing Go coverage profile");
  }
  for (const profile of profiles) {
    const lines = profile.trimEnd().split(/\r?\n/),
      header = lines.shift();
    if (!header || !/^mode: (?:set|count|atomic)$/.test(header) || (mode && mode !== header)) {
      throw new TestError("invalid-report", "Invalid or conflicting Go cover profile mode");
    }
    mode = header;
    for (const line of lines) {
      const match = /^(.*):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/.exec(line);
      if (!match) {
        throw new TestError("invalid-report", "Malformed Go coverage block");
      }
      const file = match[1] ?? "",
        numbers = match.slice(2).map(Number);
      if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0) || numbers.slice(0, 4).some((n) => n < 1)) {
        throw new TestError("invalid-report", "Invalid Go coverage coordinates");
      }
      // Native instrumentation includes generated/test support; only owned sources count.
      const owned = paths.get(file);
      if (!owned) {
        continue;
      }
      const key = `${owned}:${match.slice(2, 6).join(":")}`,
        statements = Number(match[6]),
        covered = Number(match[7]) > 0,
        old = blocks.get(key);
      if (old && old.statements !== statements) {
        throw new TestError("invalid-report", "Inconsistent Go coverage block metadata");
      }
      blocks.set(key, { statements, covered: covered || !!old?.covered });
    }
  }
  let total = 0,
    covered = 0;
  for (const block of blocks.values()) {
    total += block.statements;
    if (block.covered) {
      covered += block.statements;
    }
  }
  return { covered, total };
}
