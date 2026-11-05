import { join } from "node:path";
import { type EcosystemTestPolicy } from "../../config/test/model";
import { readProjectionFile } from "../../lint/files";
import { TestError } from "../model";
import { type TestTarget } from "../targets";

export async function findCoverageConfig(target: TestTarget): Promise<string> {
  for (const name of [".coveragerc", "setup.cfg", "tox.ini"]) {
    const path = join(target.scope.cwd, name);
    const snapshot = await readProjectionFile(target.root, path);
    if (snapshot.text !== null && (name === ".coveragerc" || /^\s*\[coverage:/m.test(snapshot.text))) {
      return path;
    }
  }
  return join(target.scope.cwd, "pyproject.toml");
}
export function coveragePolicy(policy: EcosystemTestPolicy) {
  return {
    run: { branch: false, source: ["."], include: policy.source.include, omit: policy.source.exclude },
    report: {
      include_namespace_packages: true,
      include: policy.source.include,
      omit: policy.source.exclude,
      fail_under: policy.coverage.minimum,
    },
  };
}
function iniValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length ? `\n${value.map((item) => `    ${String(item)}`).join("\n")}` : "";
  }
  return String(value);
}
interface IniEntry {
  section: string;
  key: string;
  indent: number;
  lines: number[];
}
function invalidIni(path: string, reason: string): never {
  throw new TestError("unsupported-config", `Cannot safely edit coverage configuration ${path}: ${reason}`);
}
function uniqueIniIdentity(seen: Set<string>, identity: string, path: string, description: string): void {
  if (seen.has(identity)) {
    invalidIni(path, `duplicate ${description}`);
  }
  seen.add(identity);
}
function iniAssignment(
  line: string,
  section: string | undefined,
  index: number,
  indent: number,
  path: string,
): IniEntry {
  const assignment = /^\s*([^\s#;][^=:#;]*?)\s*[=:]/.exec(line);
  if (section === undefined || !assignment) {
    invalidIni(path, `unsupported statement at line ${index + 1}`);
  }
  return { section, key: assignment[1]?.trim().toLowerCase() ?? "", indent, lines: [index] };
}
function iniEntries(lines: string[], path: string): IniEntry[] {
  const sections = new Set<string>(),
    keys = new Set<string>(),
    entries: IniEntry[] = [];
  let section: string | undefined, previous: IniEntry | undefined;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:[#;].*)?$/.test(line)) {
      continue;
    }
    const header = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line)?.[1];
    if (header !== undefined) {
      uniqueIniIdentity(sections, header, path, `section [${header}]`);
      section = header;
      previous = undefined;
      continue;
    }
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (previous && indent > previous.indent) {
      previous.lines.push(index);
      continue;
    }
    previous = iniAssignment(line, section, index, indent, path);
    uniqueIniIdentity(
      keys,
      JSON.stringify([previous.section, previous.key]),
      path,
      `option ${previous.section}.${previous.key}`,
    );
    entries.push(previous);
  }
  return entries;
}
/** Edit only owned coverage sections/keys, retaining pytest and package configuration. */
export function editCoverageIni(
  before: string,
  desired: ReturnType<typeof coveragePolicy>,
  sectionPrefix: string,
  previous: readonly string[][],
  path = "coverage configuration",
): { content: string; fields: string[][] } {
  const fields = Object.entries(desired).flatMap(([section, values]) =>
    Object.keys(values).map((key) => [`${sectionPrefix}${section}`, key]),
  );
  const owned = new Set([...previous, ...fields].map((field) => JSON.stringify(field)));
  const lines = before.split(/\r?\n/);
  const dropped = new Set(
    iniEntries(lines, path)
      .filter((entry) => owned.has(JSON.stringify([entry.section, entry.key])))
      .flatMap((entry) => entry.lines),
  );
  const output = lines.filter((_line, index) => !dropped.has(index));
  let content = output.join("\n");
  for (const [name, values] of Object.entries(desired)) {
    const section = `${sectionPrefix}${name}`;
    const entries = Object.entries(values)
      .map(([key, value]) => `${key} = ${iniValue(value)}\n`)
      .join("");
    const lines = content.split("\n");
    const at = lines.findIndex((line) => /^\s*\[([^\]]+)\]/.exec(line)?.[1] === section);
    if (at >= 0) {
      lines.splice(at + 1, 0, entries.trimEnd());
      content = lines.join("\n");
    } else {
      content = `${content.trimEnd()}\n[${section}]\n${entries}`;
    }
  }
  return { content: `${content.trimEnd()}\n`, fields };
}
