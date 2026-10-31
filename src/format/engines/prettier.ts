import { readFile } from "node:fs/promises";
import * as prettier from "prettier";
import toml from "prettier-plugin-toml";
import type { FormatPolicy } from "../../config/format/model";

// Taplo 0.5 already emits CRLF when requested; Prettier then applies it again.
// Keep the embedded parser's output LF and let Prettier own line endings once.
const tomlParser = toml.parsers?.toml;
if (!tomlParser) throw new Error("Bundled TOML parser is missing");
const tomlPlugin: prettier.Plugin = {
  ...toml,
  parsers: {
    toml: {
      ...tomlParser,
      parse: (text, options) =>
        tomlParser.parse(text, { ...options, endOfLine: "lf" }),
    },
  },
};
export const prettierVersion = prettier.version;
// Support metadata includes the bundled TOML options. Never load project plugins.
const supported = prettier
  .getSupportInfo({ plugins: [tomlPlugin] })
  .then((info) => new Set(info.options.map((option) => option.name)));
async function options(
  parser: string,
  policy: FormatPolicy["prettier"],
): Promise<prettier.Options> {
  const names = await supported;
  return {
    ...Object.fromEntries(
      Object.entries(policy).filter(
        ([name]) => names.has(name) && name !== "plugins" && name !== "parser",
      ),
    ),
    parser,
    plugins: parser === "toml" ? [tomlPlugin] : [],
  };
}
/** The caller selects the parser; config, editorconfig and plugins are never discovered. */
export async function formatPrettier(
  text: string,
  parser: string,
  policy: FormatPolicy["prettier"],
): Promise<string> {
  return prettier.format(text, await options(parser, policy));
}
export async function checkPrettier(
  text: string,
  parser: string,
  policy: FormatPolicy["prettier"],
): Promise<boolean> {
  return prettier.check(text, await options(parser, policy));
}
export async function checkPrettierFile(
  path: string,
  parser: string,
  policy: FormatPolicy["prettier"],
): Promise<boolean> {
  return checkPrettier(await readFile(path, "utf8"), parser, policy);
}
