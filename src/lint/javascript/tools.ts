import type { ToolVersions } from "../adapters/types";

export const BIOME_PACKAGE = "@biomejs/biome";
export const BIOME_TOOL = { package: BIOME_PACKAGE, binary: "biome" } as const;

/** Only Biome belongs to the current managed JavaScript lint environment. */
export function nativeJavascriptTools(tools: ToolVersions): ToolVersions {
  const version = tools[BIOME_PACKAGE];
  return version ? { [BIOME_PACKAGE]: version } : {};
}
