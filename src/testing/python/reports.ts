import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { type CoverageTotals, type TestCase, TestError, type TestSummary } from "../model";
export function invalidReport(message: string): never {
  throw new TestError("invalid-report", message);
}
export async function reportText(path: string): Promise<string> {
  if ((await stat(path)).size > 16 * 1024 * 1024) {
    invalidReport("Native report exceeds 16 MiB");
  }
  return readFile(path, "utf8");
}
export function reportPath(cwd: string, file: string): string {
  return relative(cwd, resolve(cwd, file)).replaceAll("\\", "/");
}
export function summarize(cases: TestCase[]): TestSummary {
  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === "passed").length,
    failed: cases.filter((c) => c.status === "failed").length,
    skipped: cases.filter((c) => c.status === "skipped").length,
    cases,
  };
}
interface Xml {
  name: string;
  attrs: Record<string, string>;
  children: Xml[];
  text: string;
}
function decode(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) {
    invalidReport("Malformed XML entity");
  }
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    const known: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    };
    if (known[entity]) {
      return known[entity];
    }
    if (/^#(?:\d+|x[\da-f]+)$/i.test(entity)) {
      return String.fromCodePoint(
        Number.parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10),
      );
    }
    return invalidReport("Unsupported XML entity");
  });
}
/** Small JUnit reader: no DTD/entity expansion, balanced tags, bounded input. */
function xmlDocument(text: string): Xml {
  if (text.length > 16 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) {
    invalidReport("Unsafe XML report");
  }
  const root: Xml = { name: "#document", attrs: {}, children: [], text: "" },
    stack = [root];
  const token = /<!--[\s\S]*?-->|<\?xml[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  let offset = 0;
  for (const match of text.matchAll(token)) {
    if (match.index !== offset) {
      invalidReport("Malformed XML");
    }
    offset += match[0].length;
    const value = match[0],
      current = stack.at(-1);
    if (!current) {
      invalidReport("Malformed XML");
    }
    if (value.startsWith("<!--") || value.startsWith("<?xml")) {
      continue;
    }
    if (value.startsWith("<![CDATA[")) {
      current.text += value.slice(9, -3);
      continue;
    }
    if (value.startsWith("</")) {
      if (value !== `</${current.name}>` || stack.length === 1) {
        invalidReport("Unbalanced XML");
      }
      stack.pop();
      continue;
    }
    if (value.startsWith("<")) {
      const start = /^<([\w:-]+)([\s\S]*?)(\/?)>$/.exec(value);
      if (!start) {
        invalidReport("Malformed XML element");
      }
      const attrs: Record<string, string> = {};
      let rest = start[2] ?? "";
      while (rest.trim()) {
        const attr = /^\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
        if (!attr || attrs[attr[1] ?? ""] !== undefined) {
          invalidReport("Malformed XML attribute");
        }
        attrs[attr[1] ?? ""] = decode(attr[2] ?? attr[3] ?? "");
        rest = rest.slice(attr[0].length);
      }
      const node: Xml = { name: start[1] ?? "", attrs, children: [], text: "" };
      current.children.push(node);
      if (!start[3]) {
        stack.push(node);
      }
      if (stack.length > 64) {
        invalidReport("XML report nesting exceeds limit");
      }
    } else {
      current.text += decode(value);
    }
  }
  if (offset !== text.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) {
    invalidReport("Incomplete XML");
  }
  return root.children[0] as Xml;
}
export function junitReport(text: string, cwd: string, selected: string[]) {
  const root = xmlDocument(text);
  if (!["testsuites", "testsuite"].includes(root.name)) {
    invalidReport("Expected JUnit testsuite");
  }
  const cases: TestCase[] = [],
    files = new Set<string>();
  let collectionError = false;
  const visit = (node: Xml, inherited?: string): void => {
    if (node.name === "testcase") {
      const raw = node.attrs.file ?? inherited;
      if (!raw) {
        invalidReport("JUnit testcase has no file");
      }
      const file = reportPath(cwd, raw);
      if (!selected.includes(file)) {
        invalidReport(`Foreign test report path: ${raw}`);
      }
      files.add(file);
      const failure = node.children.find((c) => c.name === "failure" || c.name === "error");
      collectionError ||= node.children.some((c) => c.name === "error");
      cases.push({
        name: node.attrs.name ?? "",
        file,
        status: failure ? "failed" : node.children.some((c) => c.name === "skipped") ? "skipped" : "passed",
        ...(failure ? { message: failure.attrs.message ?? failure.text } : {}),
        ...(node.attrs.time ? { duration_ms: Number(node.attrs.time) * 1000 } : {}),
      });
      return;
    }
    if (!["testsuites", "testsuite"].includes(node.name)) {
      return;
    }
    collectionError ||= Number(node.attrs.errors ?? 0) > 0;
    const before = cases.length;
    for (const child of node.children) {
      visit(child, node.attrs.file ?? inherited);
    }
    if (
      node.attrs.tests !== undefined &&
      (!/^\d+$/.test(node.attrs.tests) || Number(node.attrs.tests) !== cases.length - before)
    ) {
      invalidReport("JUnit test count does not match cases");
    }
  };
  visit(root);
  return {
    tests: summarize(cases),
    executed_files: [...files],
    collectionError,
  };
}
export function completeCoverage(entries: Map<string, CoverageTotals>, sources: string[]): CoverageTotals {
  let covered = 0,
    total = 0;
  for (const file of sources) {
    const value = entries.get(file);
    if (!value) {
      invalidReport(`Coverage missing source: ${file}`);
    }
    if (
      !Number.isSafeInteger(value.total) ||
      !Number.isSafeInteger(value.covered) ||
      value.covered < 0 ||
      value.total < value.covered
    ) {
      invalidReport(`Invalid coverage: ${file}`);
    }
    covered += value.covered;
    total += value.total;
  }
  return { covered, total };
}
export function pythonCoverage(text: string, cwd: string, sources: string[]): CoverageTotals {
  const data = JSON.parse(text);
  if (!data.files || typeof data.files !== "object") {
    invalidReport("Expected coverage.py files");
  }
  const entries = new Map<string, CoverageTotals>();
  for (const [file, value] of Object.entries(data.files)) {
    const summary = (value as { summary?: { covered_lines: number; num_statements: number } }).summary;
    if (!summary) {
      invalidReport("Invalid coverage.py summary");
    }
    entries.set(reportPath(cwd, file), {
      covered: summary.covered_lines,
      total: summary.num_statements,
    });
  }
  return completeCoverage(entries, sources);
}
export function lcovReport(text: string, cwd: string, sources: string[]): CoverageTotals {
  const entries = new Map<string, CoverageTotals>();
  let file: string | undefined,
    lines = new Map<number, number>();
  let found: number | undefined, hit: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      if (file) {
        invalidReport("Unfinished LCOV record");
      }
      file = reportPath(cwd, line.slice(3));
      lines = new Map();
      found = undefined;
      hit = undefined;
    } else if (line.startsWith("DA:")) {
      const m = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line);
      if (!file || !m) {
        invalidReport("Invalid LCOV line");
      }
      const n = Number(m[1]);
      if (n < 1 || lines.has(n)) {
        invalidReport("Duplicate LCOV line");
      }
      lines.set(n, Number(m[2]));
    } else if (line.startsWith("LF:")) {
      found = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      hit = Number(line.slice(3));
    } else if (line === "end_of_record") {
      if (!file || entries.has(file)) {
        invalidReport("Invalid LCOV record");
      }
      const covered = [...lines.values()].filter((n) => n > 0).length;
      if (found !== lines.size || hit !== covered) {
        invalidReport("Incomplete LCOV counts");
      }
      entries.set(file, { total: lines.size, covered });
      file = undefined;
    }
  }
  if (file) {
    invalidReport("Truncated LCOV report");
  }
  return completeCoverage(entries, sources);
}
