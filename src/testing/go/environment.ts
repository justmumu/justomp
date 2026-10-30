import { TestError } from "../model";

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
export function testGoFlags(input: string): string {
  const fields: string[] = [];
  let rest = input;
  while (rest.trimStart()) {
    rest = rest.trimStart();
    const quote = rest[0];
    let field: string, raw: string;
    if (quote === "'" || quote === '"') {
      const end = rest.indexOf(quote, 1);
      if (end < 0)
        throw new TestError("unsupported-config", "Unterminated GOFLAGS quote");
      field = rest.slice(1, end);
      raw = rest.slice(0, end + 1);
      rest = rest.slice(end + 1);
    } else {
      const end = rest.search(/\s/);
      raw = end < 0 ? rest : rest.slice(0, end);
      field = raw;
      rest = end < 0 ? "" : rest.slice(end);
    }
    const name = /^-([a-z]+)(?:=|$)/.exec(field)?.[1];
    if (name && owned.has(name)) continue;
    if (!name || !build.has(name))
      throw new TestError(
        "unsupported-config",
        `Unsupported GOFLAGS control: ${field}`,
      );
    fields.push(raw);
  }
  return [...fields, "-mod=readonly"].join(" ");
}
