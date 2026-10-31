import type { JavascriptPolicy } from "../lint/model";
import { EXCLUDED_DIRECTORIES } from "../scope-defaults";
import type { FormatPolicy } from "./model";
export const PRETTIER_DEFAULTS: JavascriptPolicy["prettier"] = {
  printWidth: 120,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  endOfLine: "lf",
};
export const FORMAT_DEFAULTS: FormatPolicy = {
  include: ["**/*"],
  exclude: [
    ...EXCLUDED_DIRECTORIES.map((name) => `**/${name}/**`),
    "**/*.tsbuildinfo",
    "**/*.generated.*",
    "**/next-env.d.ts",
  ],
  prettier: PRETTIER_DEFAULTS,
};
