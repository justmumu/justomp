import { isDeepStrictEqual } from "node:util";
import { parse as toml } from "smol-toml";
import { parse as yaml } from "yaml";
import { PRETTIER_DEFAULTS } from "../config/format/defaults";
import { formatPrettier } from "./engines/prettier";

/** Line endings are style; the ownership text is still required verbatim. */
export function hasProjectionMarker(text: string, marker: string): boolean {
  return text.split(/\r?\n/, 1)[0] === marker.trimEnd();
}
export async function equivalentConfig(
  before: string | null,
  expected: string,
  parser: "toml" | "json" | "jsonc" | "yaml" | "babel",
): Promise<boolean> {
  if (before === expected) {
    return true;
  }
  if (before === null) {
    return false;
  }
  try {
    if (parser === "babel") {
      const [actual, wanted] = await Promise.all([
        formatPrettier(before, parser, {
          ...PRETTIER_DEFAULTS,
          objectWrap: "collapse",
        }),
        formatPrettier(expected, parser, {
          ...PRETTIER_DEFAULTS,
          objectWrap: "collapse",
        }),
      ]);
      return actual === wanted;
    }
    const parse = (text: string): unknown => {
      switch (parser) {
        case "toml":
          return toml(text, { integersAsBigInt: true });
        case "yaml":
          return yaml(text);
        case "jsonc":
          return Bun.JSONC.parse(text);
        default:
          return JSON.parse(text);
      }
    };
    return isDeepStrictEqual(parse(before), parse(expected));
  } catch {
    return false;
  }
}
