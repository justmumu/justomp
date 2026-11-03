import { ReleaseError } from "../model";
import { releaseObject } from "../participants";
import { type ReferenceEdit } from "../references";

function applyReference(data: Record<string, unknown>, edit: ReferenceEdit): void {
  let node = data;
  for (const field of edit.field.slice(0, -1)) {
    node = releaseObject(node[field]);
  }
  const key = edit.field.at(-1);
  if (!key || node[key] !== edit.before) {
    throw new ReleaseError("metadata-conflict", `Release reference changed at ${edit.field.join(".")}`);
  }
  node[key] = edit.after;
}
export function projectJavascriptRelease(
  before: string,
  target: string | null,
  edits: readonly ReferenceEdit[],
): string {
  const data = releaseObject(JSON.parse(before));
  if (target !== null) {
    if (typeof data.version !== "string") {
      throw new ReleaseError("metadata-conflict", "JavaScript release version disappeared");
    }
    data.version = target;
  }
  for (const edit of edits) {
    applyReference(data, edit);
  }
  const indent = /\n([ \t]+)"/.exec(before)?.[1] ?? "  ";
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  return JSON.stringify(data, null, indent).replaceAll("\n", eol) + eol;
}
