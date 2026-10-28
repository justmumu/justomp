import type { GoReplace } from "../model";

interface Token {
  text: string;
  line: number;
}
export interface GoDocument {
  module?: string;
  go?: string;
  requires: { name: string; version: string }[];
  replaces: GoReplace[];
  uses: string[];
  unsupported: string[];
}
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0,
    line = 1;
  while (i < source.length) {
    const c = source[i] as string;
    if (c === "\r" || c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\n") {
      tokens.push({ text: "\n", line: line++ });
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ text: c, line });
      i++;
      continue;
    }
    if (c === "=" && source[i + 1] === ">") {
      tokens.push({ text: "=>", line });
      i += 2;
      continue;
    }
    if (c === '"' || c === "`") {
      const quote = c;
      const start = line;
      let value = "";
      i++;
      let closed = false;
      while (i < source.length) {
        const next = source[i++] as string;
        if (next === quote) {
          closed = true;
          break;
        }
        if (next === "\n") {
          if (quote === '"') throw new Error(`newline in Go string at ${line}`);
          line++;
        }
        if (next === "\\" && quote === '"') {
          const escapeCode = source[i++] as string;
          const simple: Record<string, string> = {
            a: "\x07",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
            v: "\v",
            "\\": "\\",
            '"': '"',
          };
          if (escapeCode in simple) {
            value += simple[escapeCode];
            continue;
          }
          const widths: Record<string, number> = { x: 2, u: 4, U: 8 };
          const count =
            widths[escapeCode] ?? (/[0-7]/.test(escapeCode ?? "") ? 2 : 0);
          if (!count) throw new Error(`invalid Go escape at ${line}`);
          const digits =
            (/[0-7]/.test(escapeCode) ? escapeCode : "") +
            source.slice(i, i + count);
          i += count;
          const base = /[0-7]/.test(escapeCode) ? 8 : 16;
          if (
            digits.length !== (base === 8 ? 3 : count) ||
            !(base === 8 ? /^[0-7]+$/ : /^[0-9a-fA-F]+$/).test(digits)
          )
            throw new Error(`invalid Go escape at ${line}`);
          const code = Number.parseInt(digits, base);
          if (
            code > 0x10ffff ||
            (code >= 0xd800 && code <= 0xdfff) ||
            (base === 8 && code > 255)
          )
            throw new Error("invalid Go character");
          value += String.fromCodePoint(code);
        } else value += next;
      }
      if (!closed) throw new Error(`unterminated Go string at ${start}`);
      tokens.push({ text: value, line: start });
      continue;
    }
    const start = i;
    while (
      i < source.length &&
      !/[\s()]/.test(source[i] as string) &&
      !(source[i] === "=" && source[i + 1] === ">")
    )
      i++;
    if (start === i) throw new Error(`unexpected Go token at ${line}`);
    tokens.push({ text: source.slice(start, i), line });
  }
  return tokens;
}
export function parseGo(source: string, kind: "mod" | "work"): GoDocument {
  const tokens = lex(source);
  let cursor = 0;
  const result: GoDocument = {
    requires: [],
    replaces: [],
    uses: [],
    unsupported: [],
  };
  const apply = (directive: string, args: string[], line: number) => {
    const bad = () => {
      throw new Error(`invalid ${directive} declaration at line ${line}`);
    };
    switch (directive) {
      case "module":
        if (kind !== "mod" || args.length !== 1 || result.module) bad();
        result.module = args[0];
        break;
      case "go":
        if (args.length !== 1 || !/^\d+\.\d+(?:\.\d+)?$/.test(args[0] ?? ""))
          bad();
        result.go = args[0];
        break;
      case "require":
        if (kind !== "mod" || args.length !== 2) bad();
        result.requires.push({
          name: args[0] as string,
          version: args[1] as string,
        });
        break;
      case "use":
        if (kind !== "work" || args.length !== 1) bad();
        result.uses.push(args[0] as string);
        break;
      case "replace": {
        const arrow = args.indexOf("=>");
        if (
          (arrow !== 1 && arrow !== 2) ||
          (args.length - arrow !== 2 && args.length - arrow !== 3)
        )
          bad();
        result.replaces.push({
          name: args[0] as string,
          ...(arrow === 2 ? { version: args[1] } : {}),
          target: args[arrow + 1] as string,
          ...(args[arrow + 2] ? { targetVersion: args[arrow + 2] } : {}),
        });
        break;
      }
      case "toolchain":
        if (args.length !== 1) bad();
        break;
      default:
        if (args.length === 0) bad();
        result.unsupported.push(directive);
    }
  };
  const lineArgs = () => {
    const row: string[] = [];
    while (
      cursor < tokens.length &&
      tokens[cursor]?.text !== "\n" &&
      tokens[cursor]?.text !== ")"
    )
      row.push((tokens[cursor++] as Token).text);
    return row;
  };
  while (cursor < tokens.length) {
    if (tokens[cursor]?.text === "\n") {
      cursor++;
      continue;
    }
    const token = tokens[cursor++] as Token;
    if (token.text === ")" || token.text === "(")
      throw new Error(`unexpected ${token.text} at ${token.line}`);
    if (tokens[cursor]?.text === "(") {
      cursor++;
      if (tokens[cursor]?.text !== "\n")
        throw new Error(`expected newline after ${token.text} (`);
      cursor++;
      while (cursor < tokens.length && tokens[cursor]?.text !== ")") {
        if (tokens[cursor]?.text === "\n") {
          cursor++;
          continue;
        }
        const line = tokens[cursor]?.line ?? token.line;
        const args = lineArgs();
        apply(token.text, args, line);
      }
      if (tokens[cursor]?.text !== ")")
        throw new Error(`unclosed ${token.text} block`);
      cursor++;
      if (cursor < tokens.length && tokens[cursor]?.text !== "\n")
        throw new Error("expected newline after block");
    } else apply(token.text, lineArgs(), token.line);
  }
  if (kind === "mod" && !result.module)
    throw new Error("go.mod has no module declaration");
  return result;
}
