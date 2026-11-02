import { TestError, type TestSuite } from "../model";

const build = new Set([
  "tags",
  "race",
  "msan",
  "asan",
  "gcflags",
  "asmflags",
  "ldflags",
  "trimpath",
  "buildvcs",
  "p",
  "compiler",
  "linkshared",
  "pkgdir",
  "installsuffix",
]);
const owned = new Set([
  "mod",
  "run",
  "skip",
  "count",
  "failfast",
  "timeout",
  "json",
  "v",
  "vet",
  "cover",
  "covermode",
  "coverpkg",
  "coverprofile",
  "bench",
  "benchtime",
  "benchmem",
  "fuzz",
  "fuzztime",
  "fuzzminimizetime",
  "list",
  "short",
  "shuffle",
  "parallel",
]);
/** Go's quoted.Fields treats quotes only at field starts, without shell expansion. */
export function testGoFlags(input: string, suite: TestSuite = "unit"): string {
  const fields: string[] = [];
  let tags: string[] | undefined;
  for (const { field, raw } of goFields(input)) {
    const name = /^-([a-z]+)(?:=|$)/.exec(field)?.[1];
    if (name && owned.has(name)) {
      continue;
    }
    if (!name || !build.has(name)) {
      throw new TestError("unsupported-config", `Unsupported GOFLAGS control: ${field}`);
    }
    if (name === "tags") {
      tags = field
        .slice(field.indexOf("=") + 1)
        .split(/[ ,]+/)
        .filter(Boolean);
    } else {
      fields.push(raw);
    }
  }
  return effectiveFlags(fields, tags, suite);
}

function* goFields(input: string): Generator<{ field: string; raw: string }> {
  let rest = input;
  while (rest.trimStart()) {
    rest = rest.trimStart();
    const parsed = goField(rest);
    const { field, raw } = parsed;
    rest = parsed.rest;
    yield { field, raw };
  }
}

function effectiveFlags(fields: string[], tags: string[] | undefined, suite: TestSuite): string {
  const effectiveTags = [...new Set((tags ?? []).filter((tag) => tag !== "integration"))];
  if (suite === "integration") {
    effectiveTags.push("integration");
  }
  return [
    ...fields,
    ...(tags || effectiveTags.length ? [`-tags=${effectiveTags.join(",")}`] : []),
    "-mod=readonly",
  ].join(" ");
}

function goField(rest: string): { field: string; raw: string; rest: string } {
  const quote = rest[0];
  let field: string, raw: string;
  if (quote === "'" || quote === '"') {
    const end = rest.indexOf(quote, 1);
    if (end < 0) {
      throw new TestError("unsupported-config", "Unterminated GOFLAGS quote");
    }
    field = rest.slice(1, end);
    raw = rest.slice(0, end + 1);
    rest = rest.slice(end + 1);
  } else {
    const end = rest.search(/\s/);
    raw = end < 0 ? rest : rest.slice(0, end);
    field = raw;
    rest = end < 0 ? "" : rest.slice(end);
  }
  return { field, raw, rest };
}
