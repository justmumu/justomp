import { parse } from "smol-toml";
import { statements } from "../../lint/projections/python";
import { ReleaseError } from "../model";
import { type ReferenceEdit } from "../references";

interface Token {
  start: number;
  end: number;
  index: number;
  value: string;
}
function stringEnd(text: string, start: number, quote: string): number {
  const delimiter = text.slice(start, start + 3) === quote.repeat(3) ? quote.repeat(3) : quote;
  for (let cursor = start + delimiter.length; cursor < text.length; cursor++) {
    if (text[cursor] === "\\" && quote === '"') {
      cursor++;
      continue;
    }
    if (text.slice(cursor, cursor + delimiter.length) === delimiter) {
      return cursor + delimiter.length;
    }
  }
  throw new ReleaseError("invalid-metadata", "Unterminated Python dependency string");
}
interface ArrayPosition {
  depth: number;
  braces: number;
  index: number;
}
function advanceArray(position: ArrayPosition, char: string | undefined): void {
  switch (char) {
    case "[":
      position.depth++;
      break;
    case "]":
      position.depth--;
      break;
    case "{":
      position.braces++;
      break;
    case "}":
      position.braces--;
      break;
    case ",":
      if (position.depth === 1 && position.braces === 0) {
        position.index++;
      }
      break;
  }
}
function arrayString(text: string, start: number, end: number, position: ArrayPosition): Token[] {
  if (position.depth !== 1 || position.braces !== 0) {
    return [];
  }
  const value = parse(`value = ${text.slice(start, end)}`).value;
  return typeof value === "string" ? [{ start, end, index: position.index, value }] : [];
}
function stringsInArray(text: string): Token[] {
  const tokens: Token[] = [],
    position = { depth: 0, braces: 0, index: 0 };
  for (let cursor = text.indexOf("=") + 1; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "#") {
      const end = text.indexOf("\n", cursor);
      cursor = end < 0 ? text.length : end;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = stringEnd(text, cursor, char);
      tokens.push(...arrayString(text, cursor, end, position));
      cursor = end - 1;
      continue;
    }
    advanceArray(position, char);
  }
  return tokens;
}
export function projectPythonReferences(before: string, edits: readonly ReferenceEdit[]): string {
  if (!edits.length) {
    return before;
  }
  const used = new Set<ReferenceEdit>();
  const output = statements(before)
    .map((part) => {
      const matching = edits.filter((edit) => JSON.stringify(edit.field.slice(0, -1)) === JSON.stringify(part.path));
      if (!matching.length) {
        return part.text;
      }
      const tokens = stringsInArray(part.text);
      const changes = matching
        .map((edit) => {
          const token = tokens.find((candidate) => candidate.index === Number(edit.field.at(-1)));
          if (!token || token.value !== edit.before) {
            throw new ReleaseError("metadata-conflict", `Python dependency changed at ${edit.field.join(".")}`);
          }
          used.add(edit);
          return { token, after: edit.after };
        })
        .sort((a, b) => b.token.start - a.token.start);
      let text = part.text;
      for (const { token, after } of changes) {
        text = text.slice(0, token.start) + JSON.stringify(after) + text.slice(token.end);
      }
      return text;
    })
    .join("");
  if (used.size !== edits.length) {
    throw new ReleaseError("unsupported-metadata", "Expand inline Python dependency tables before release projection");
  }
  parse(output);
  return output;
}
