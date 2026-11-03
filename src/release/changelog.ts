import createPreset from "conventional-changelog-conventionalcommits";
import { type Options, writeChangelogString } from "conventional-changelog-writer";
import { type CommitBase, CommitParser, type ParserOptions } from "conventional-commits-parser";
import { type HistoryCommit } from "./history";
import { ReleaseError } from "./model";

type NoteCommit = CommitBase & { hash: string; type: string; scope: string; subject: string };
const sections = new Map([
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "CI"],
  ["style", "Style"],
  ["chore", "Maintenance"],
  ["revert", "Reverts"],
]);
export async function renderReleaseNotes(
  records: readonly HistoryCommit[],
): Promise<{ body: string; included: string[]; skipped: string[] }> {
  const preset = createPreset() as { parser: ParserOptions };
  const parser = new CommitParser(preset.parser);
  const parsed: NoteCommit[] = [];
  const skipped: string[] = [];
  for (const record of records) {
    const commit = parser.parse(record.message);
    if (!commit.type || !commit.subject) {
      skipped.push(record.hash);
      continue;
    }
    parsed.push({
      ...commit,
      hash: record.hash,
      type: commit.type.toLowerCase(),
      scope: commit.scope ?? "",
      subject: commit.subject,
    });
  }
  if (!parsed.length) {
    return { body: "No changes.\n", included: [], skipped };
  }
  const types = [
    ...sections.keys(),
    ...[...new Set(parsed.map((c) => c.type ?? ""))].filter((type) => !sections.has(type)).sort(),
  ];
  const configured = createPreset({
    types: types.map((type) => ({
      type,
      section: sections.get(type) ?? type,
      effect: "changelog",
    })),
  }) as { writer: Options<NoteCommit> };
  const body = await writeChangelogString(
    parsed,
    { version: "Unreleased", date: "", linkReferences: false, linkCompare: false },
    {
      ...configured.writer,
      ignoreReverted: false,
      generateOn: () => false,
      headerPartial: () => "",
      commitsSort: ["scope", "subject", "hash"],
    },
  );
  return { body: `${body.trim()}\n`, included: parsed.map((c) => c.hash), skipped };
}
interface Block {
  key: string;
  start: number;
  end: number;
  body: string;
}
function marker(key: string, edge: "start" | "end"): string {
  return `<!-- justomp:${key}:${edge} -->`;
}
function blocks(text: string): Block[] {
  const tokens = [...text.matchAll(/<!-- justomp:(unreleased|release:\d+\.\d+\.\d+):(start|end) -->/g)];
  if ((text.match(/<!--\s*justomp:/g)?.length ?? 0) !== tokens.length) {
    throw new ReleaseError("changelog-conflict", "Malformed Justomp changelog marker");
  }
  const result: Block[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < tokens.length; i += 2) {
    const begin = tokens[i],
      end = tokens[i + 1];
    if (!begin || !end || begin[2] !== "start" || end[2] !== "end" || begin[1] !== end[1] || keys.has(begin[1] ?? "")) {
      throw new ReleaseError("changelog-conflict", "Duplicate or unbalanced Justomp changelog markers");
    }
    const key = begin[1] as string;
    keys.add(key);
    result.push({
      key,
      start: begin.index,
      end: end.index + end[0].length,
      body: text.slice(begin.index + begin[0].length, end.index),
    });
  }
  return result;
}
function section(text: string, label: string): { start: number; body: number; end: number } | null {
  const headings = [...text.matchAll(/^##[ \t]+(?:\[([^\]\r\n]+)\]|([^\s\r\n]+))[^\r\n]*(?:\r?\n|$)/gm)];
  const matches = headings.filter((h) => (h[1] ?? h[2])?.replace(/^v(?=\d+\.\d+\.\d+$)/, "") === label);
  if (matches.length > 1) {
    throw new ReleaseError("changelog-conflict", `Duplicate changelog heading: ${label}`);
  }
  const match = matches[0];
  if (!match) {
    return null;
  }
  const index = headings.indexOf(match);
  return { start: match.index, body: match.index + match[0].length, end: headings[index + 1]?.index ?? text.length };
}
function insertion(text: string): number {
  return /^#[ \t]+[^\n]*\n(?:\r?\n)?/.exec(text)?.[0].length ?? 0;
}
function generated(key: string, body: string): string {
  if (/<!--\s*justomp:/.test(body)) {
    throw new ReleaseError("changelog-conflict", "Generated notes contain a reserved Justomp changelog marker");
  }
  return `${marker(key, "start")}\n${body.trim()}\n${marker(key, "end")}`;
}
export function updateUnreleased(before: string | null, body: string): string {
  const text = before ?? "# Changelog\n\n";
  const owned = blocks(text).find((block) => block.key === "unreleased");
  const current = section(text, "Unreleased");
  const content = generated("unreleased", body);
  if (owned) {
    if (!current || owned.start < current.body || owned.end > current.end) {
      throw new ReleaseError("changelog-conflict", "Unreleased marker is outside its section");
    }
    return text.slice(0, owned.start) + content + text.slice(owned.end);
  }
  const at = current?.body ?? insertion(text);
  return text.slice(0, at) + (current ? "\n" : "## [Unreleased]\n\n") + content + "\n\n" + text.slice(at);
}
export function addRelease(
  before: string | null,
  version: string,
  date: string,
  body: string,
): { text: string; manualUnreleased: boolean } {
  let text = before ?? "# Changelog\n\n";
  const owned = blocks(text).find((block) => block.key === "unreleased");
  if (section(text, version) || blocks(text).some((block) => block.key === `release:${version}`)) {
    throw new ReleaseError("changelog-conflict", `Release section ${version} already exists`);
  }
  const current = section(text, "Unreleased");
  if (owned) {
    if (!current || owned.start < current.body || owned.end > current.end) {
      throw new ReleaseError("changelog-conflict", "Unreleased marker is outside its section");
    }
    text = text.slice(0, owned.start) + text.slice(owned.end);
  }
  const unreleased = section(text, "Unreleased");
  const manualUnreleased = !!unreleased && !!text.slice(unreleased.body, unreleased.end).trim();
  const at = unreleased?.end ?? insertion(text);
  const release = `## [${version}] - ${date}\n\n${generated(`release:${version}`, body)}\n\n`;
  return { text: text.slice(0, at) + release + text.slice(at), manualUnreleased };
}
export function validateReleaseSection(text: string, version: string): void {
  const owned = blocks(text).find((block) => block.key === `release:${version}`);
  const current = section(text, version);
  if (!owned || !current || owned.start < current.body || owned.end > current.end || !owned.body.trim()) {
    throw new ReleaseError("changelog-conflict", `Expected one nonempty managed release section for ${version}`);
  }
}
