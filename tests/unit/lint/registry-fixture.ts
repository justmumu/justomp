import { spyOn } from "bun:test";
import * as versions from "../../../src/lint/versions";
import { TOOLS } from "../../fixtures/lint/javascript/versions";
export function registryFixture() {
  const records: Record<string, Record<string, unknown>> = {};
  for (const [name, version] of Object.entries(TOOLS))
    records[name] = {
      [version]: {
        name,
        version,
        peerDependencies:
          name === "eslint" ||
          name === "prettier" ||
          name === "@next/eslint-plugin-next"
            ? {}
            : {
                eslint: "^9.0.0",
                ...(name === "typescript-eslint"
                  ? { typescript: ">=4.8.4 <6.0.0" }
                  : {}),
              },
        engines: { node: ">=18" },
      },
    };
  records.eslint = {
    ...records.eslint,
    "10.0.0": { name: "eslint", version: "10.0.0", engines: { node: ">=18" } },
    "11.0.0-beta.1": { name: "eslint", version: "11.0.0-beta.1" },
  };
  records["@eslint/js"] = {
    ...records["@eslint/js"],
    "10.0.0": {
      name: "@eslint/js",
      version: "10.0.0",
      peerDependencies: { eslint: "^10.0.0" },
    },
  };
  records.typescript = {
    "7.0.2": { name: "typescript", version: "7.0.2" },
    "5.9.3": { name: "typescript", version: "5.9.3" },
  };

  const latest: Record<string, string | undefined> = {
    ...TOOLS,
    eslint: "10.0.0",
    "@eslint/js": "10.0.0",
    typescript: "7.0.2",
  };
  let calls = 0;
  const fetcher = spyOn(versions, "fetchVersionJSON").mockImplementation(
    async (url: string) => {
      calls++;
      const path = new URL(String(url)).pathname
        .slice(1)
        .split("/")
        .map(decodeURIComponent);
      if (path[0] === "-" && path[1] === "package" && path[3] === "dist-tags")
        return { latest: latest[path[2] ?? ""] };
      const data = records[path[0] ?? ""];
      if (!data) throw new Error(`Missing fixture metadata ${url}`);
      return path[1] ? data[path[1]] : { versions: data };
    },
  );
  return { fetcher, records, latest, calls: () => calls };
}
