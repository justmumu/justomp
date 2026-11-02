import { spyOn } from "bun:test";
import * as versions from "../../../src/lint/versions";
import { TOOLS } from "../../fixtures/lint/javascript/versions";
import { suppliedResponse } from "../../response";
export function registryFixture() {
  const records: Record<string, Record<string, unknown>> = {};
  for (const [name, version] of Object.entries(TOOLS)) {
    records[name] = {
      [version]: {
        name,
        version,
        peerDependencies: {},
        engines: { node: ">=18" },
      },
    };
  }
  const latest: Record<string, string | undefined> = { ...TOOLS };
  let calls = 0;
  const fetcher = spyOn(versions, "fetchVersionJSON").mockImplementation((url: string) => {
    return suppliedResponse(() => {
      return metadata(url);
    });
  });
  function metadata(url: string) {
    calls++;
    const path = new URL(url).pathname.slice(1).split("/").map(decodeURIComponent);
    if (path[0] === "-" && path[1] === "package" && path[3] === "dist-tags") {
      return { latest: latest[path[2] ?? ""] };
    }
    const data = records[path[0] ?? ""];
    if (!data) {
      throw new Error(`Missing fixture metadata ${url}`);
    }
    return path[1] ? data[path[1]] : { versions: data };
  }
  return { fetcher, records, latest, calls: () => calls };
}
