import { TestError } from "../model";
export interface GoRunnable {
  file: string;
  name: string;
}
export interface GoPackage {
  Dir: string;
  ImportPath: string;
  Name: string;
  GoFiles?: string[];
  CgoFiles?: string[];
  TestGoFiles?: string[];
  XTestGoFiles?: string[];
  Error?: { Err: string };
}
export function selectGoTests(
  inventory: readonly GoRunnable[],
  selected: readonly string[],
): { names: string[]; pattern: string } {
  const selectedSet = new Set(selected),
    names = [...new Set(inventory.filter((r) => selectedSet.has(r.file)).map((r) => r.name))].sort();
  const excluded = new Map<string, GoRunnable[]>();
  for (const item of inventory) {
    if (!selectedSet.has(item.file)) {
      const matches = excluded.get(item.name) ?? [];
      matches.push(item);
      excluded.set(item.name, matches);
    }
  }
  for (const name of names) {
    const conflict = excluded.get(name) ?? [];
    if (conflict.length) {
      throw new TestError(
        "unsupported-test-selection",
        `Go cannot distinguish ${name} in selected files from ${conflict.map((r) => r.file).join(", ")}`,
      );
    }
  }
  return {
    names,
    pattern: names.length ? `^(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$` : "^$",
  };
}
/** Go emits concatenated JSON objects, not an array. */
export function parseGoPackages(text: string): GoPackage[] {
  const chunks: string[] = [];
  const state: { depth: number; start: number; quoted: boolean; escaped: boolean } = {
    depth: 0,
    start: 0,
    quoted: false,
    escaped: false,
  };
  for (let i = 0; i < text.length; i++) {
    collectJsonChunk(text, i, state, chunks);
  }
  if (state.depth || state.quoted || !chunks.length) {
    throw new TestError("invalid-report", "Invalid go list output");
  }
  return chunks.map((c) => {
    const p = JSON.parse(c) as GoPackage;
    if (!p.Dir || !p.ImportPath || p.Error) {
      throw new TestError("collection-failed", p.Error?.Err ?? "Invalid Go package");
    }
    return p;
  });
}

interface JsonScan {
  depth: number;
  start: number;
  quoted: boolean;
  escaped: boolean;
}
function collectJsonChunk(text: string, i: number, state: JsonScan, chunks: string[]): void {
  const c = text[i];
  if (state.quoted) {
    advanceJsonString(c, state);
    return;
  }
  if (c === '"') {
    state.quoted = true;
  } else if (c === "{") {
    if (state.depth++ === 0) {
      state.start = i;
    }
  } else if (c === "}" && --state.depth === 0) {
    chunks.push(text.slice(state.start, i + 1));
  }
}

function advanceJsonString(c: string | undefined, state: JsonScan): void {
  if (state.escaped) {
    state.escaped = false;
  } else if (c === "\\") {
    state.escaped = true;
  } else if (c === '"') {
    state.quoted = false;
  }
}
