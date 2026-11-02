import { type GoReplace } from "../model";

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
class GoLexer {
  private i = 0;
  private line = 1;
  constructor(private readonly source: string) {}
  private escape(): string {
    const escapeCode = this.source[this.i++] as string;
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
      return simple[escapeCode] as string;
    }
    const widths: Record<string, number> = { x: 2, u: 4, U: 8 };
    const octal = /[0-7]/.test(escapeCode);
    const count = widths[escapeCode] ?? (octal ? 2 : 0);
    if (!count) {
      throw new Error(`invalid Go escape at ${this.line}`);
    }
    return this.numericEscape(escapeCode, octal, count);
  }
  private numericEscape(escapeCode: string, octal: boolean, count: number): string {
    const digits = (octal ? escapeCode : "") + this.source.slice(this.i, this.i + count);
    this.i += count;
    const base = octal ? 8 : 16;
    if (digits.length !== (octal ? 3 : count) || !(octal ? /^[0-7]+$/ : /^[0-9a-fA-F]+$/).test(digits)) {
      throw new Error(`invalid Go escape at ${this.line}`);
    }
    return goCharacter(digits, base, octal);
  }

  private quoted(quote: string): Token {
    const start = this.line;
    let value = "";
    this.i++;
    while (this.i < this.source.length) {
      const next = this.source[this.i++] as string;
      if (next === quote) {
        return { text: value, line: start };
      }
      this.newline(next, quote);
      value += next === "\\" && quote === '"' ? this.escape() : next;
    }
    throw new Error(`unterminated Go string at ${start}`);
  }
  private newline(next: string, quote: string): void {
    if (next !== "\n") {
      return;
    }
    if (quote === '"') {
      throw new Error(`newline in Go string at ${this.line}`);
    }
    this.line++;
  }
  private bare(): Token {
    const start = this.i;
    while (this.i < this.source.length && !/[\s()]/.test(this.source[this.i] as string) && !this.arrow()) {
      this.i++;
    }
    if (start === this.i) {
      throw new Error(`unexpected Go token at ${this.line}`);
    }
    return { text: this.source.slice(start, this.i), line: this.line };
  }
  private arrow(): boolean {
    return this.source[this.i] === "=" && this.source[this.i + 1] === ">";
  }
  private next(): Token | undefined {
    const c = this.source[this.i] as string;
    if (c === "\r" || c === " " || c === "\t") {
      this.i++;
      return;
    }
    if (c === "\n") {
      this.i++;
      return { text: "\n", line: this.line++ };
    }
    if (c === "/" && this.source[this.i + 1] === "/") {
      while (this.i < this.source.length && this.source[this.i] !== "\n") {
        this.i++;
      }
      return;
    }
    return this.token(c);
  }
  private token(c: string): Token {
    if (c === "(" || c === ")") {
      this.i++;
      return { text: c, line: this.line };
    }
    if (this.arrow()) {
      this.i += 2;
      return { text: "=>", line: this.line };
    }
    if (c === '"' || c === "`") {
      return this.quoted(c);
    }
    return this.bare();
  }
  lex(): Token[] {
    const tokens: Token[] = [];
    while (this.i < this.source.length) {
      const token = this.next();
      if (token) {
        tokens.push(token);
      }
    }
    return tokens;
  }
}
function bad(directive: string, line: number): never {
  throw new Error(`invalid ${directive} declaration at line ${line}`);
}
function replace(args: string[], line: number): GoReplace {
  const arrow = args.indexOf("=>");
  if ((arrow !== 1 && arrow !== 2) || (args.length - arrow !== 2 && args.length - arrow !== 3)) {
    bad("replace", line);
  }
  return {
    name: args[0] as string,
    ...(arrow === 2 ? { version: args[1] as string } : {}),
    target: args[arrow + 1] as string,
    ...(args[arrow + 2] ? { targetVersion: args[arrow + 2] } : {}),
  };
}
function applyMetadata(
  result: GoDocument,
  directive: string,
  args: string[],
  line: number,
  kind: "mod" | "work",
): void {
  if (directive === "module") {
    if (kind !== "mod" || args.length !== 1 || result.module) {
      bad(directive, line);
    }
    result.module = args[0] as string;
  } else {
    if (args.length !== 1 || !/^\d+\.\d+(?:\.\d+)?$/.test(args[0] ?? "")) {
      bad(directive, line);
    }
    result.go = args[0] as string;
  }
}
function requireArgs(kind: "mod" | "work", args: string[], line: number): void {
  if (kind !== "mod" || args.length !== 2) {
    bad("require", line);
  }
}
function apply(result: GoDocument, directive: string, args: string[], line: number, kind: "mod" | "work"): void {
  switch (directive) {
    case "module":
    case "go":
      applyMetadata(result, directive, args, line, kind);
      break;
    case "require":
      requireArgs(kind, args, line);
      result.requires.push({ name: args[0] as string, version: args[1] as string });
      break;
    case "use":
      if (kind !== "work" || args.length !== 1) {
        bad(directive, line);
      }
      result.uses.push(args[0] as string);
      break;
    case "replace":
      result.replaces.push(replace(args, line));
      break;
    case "toolchain":
      if (args.length !== 1) {
        bad(directive, line);
      }
      break;
    default:
      if (args.length === 0) {
        bad(directive, line);
      }
      result.unsupported.push(directive);
  }
}
class GoParser {
  private cursor = 0;
  private readonly result: GoDocument = { requires: [], replaces: [], uses: [], unsupported: [] };
  constructor(
    private readonly tokens: Token[],
    private readonly kind: "mod" | "work",
  ) {}
  private lineArgs(): string[] {
    const row: string[] = [];
    while (
      this.cursor < this.tokens.length &&
      this.tokens[this.cursor]?.text !== "\n" &&
      this.tokens[this.cursor]?.text !== ")"
    ) {
      row.push((this.tokens[this.cursor++] as Token).text);
    }
    return row;
  }
  private block(token: Token): void {
    this.cursor++;
    if (this.tokens[this.cursor]?.text !== "\n") {
      throw new Error(`expected newline after ${token.text} (`);
    }
    this.cursor++;
    while (this.cursor < this.tokens.length && this.tokens[this.cursor]?.text !== ")") {
      if (this.tokens[this.cursor]?.text === "\n") {
        this.cursor++;
        continue;
      }
      const line = this.tokens[this.cursor]?.line ?? token.line;
      apply(this.result, token.text, this.lineArgs(), line, this.kind);
    }
    if (this.tokens[this.cursor]?.text !== ")") {
      throw new Error(`unclosed ${token.text} block`);
    }
    this.cursor++;
    if (this.cursor < this.tokens.length && this.tokens[this.cursor]?.text !== "\n") {
      throw new Error("expected newline after block");
    }
  }
  private directive(): void {
    const token = this.tokens[this.cursor++] as Token;
    if (token.text === ")" || token.text === "(") {
      throw new Error(`unexpected ${token.text} at ${token.line}`);
    }
    if (this.tokens[this.cursor]?.text === "(") {
      this.block(token);
    } else {
      apply(this.result, token.text, this.lineArgs(), token.line, this.kind);
    }
  }
  parse(): GoDocument {
    while (this.cursor < this.tokens.length) {
      if (this.tokens[this.cursor]?.text === "\n") {
        this.cursor++;
        continue;
      }
      this.directive();
    }
    if (this.kind === "mod" && !this.result.module) {
      throw new Error("go.mod has no module declaration");
    }
    return this.result;
  }
}
export function parseGo(source: string, kind: "mod" | "work"): GoDocument {
  return new GoParser(new GoLexer(source).lex(), kind).parse();
}

function goCharacter(digits: string, base: number, octal: boolean): string {
  const code = Number.parseInt(digits, base);
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (octal && code > 255)) {
    throw new Error("invalid Go character");
  }
  return String.fromCodePoint(code);
}
