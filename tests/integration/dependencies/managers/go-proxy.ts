import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function createGoProxy(directory: string) {
  const modules = ["example.test/lib", "example.test/transitive"];
  for (const module of modules) {
    const versions = module.endsWith("lib") ? ["v1.0.0", "v1.1.0", "v1.2.0"] : ["v1.0.0"];
    const folder = join(directory, module, "@v");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "list"), versions.join("\n"));
    for (const version of versions) {
      const goMod = `module ${module}\ngo 1.25\n${module.endsWith("lib") ? "require example.test/transitive v1.0.0\n" : ""}`;
      const source = module.endsWith("lib")
        ? 'package lib\nimport _ "example.test/transitive"\n'
        : "package transitive\n";
      await writeFile(join(folder, `${version}.mod`), goMod);
      await writeFile(
        join(folder, `${version}.info`),
        JSON.stringify({ Version: version, Time: "2025-01-01T00:00:00Z" }),
      );
      const zip = spawnSync(
        "python3",
        [
          "-c",
          "import sys,zipfile,json\np,m,v,g,s=sys.argv[1:]\nwith zipfile.ZipFile(p,'w') as z:\n z.writestr(m+'@'+v+'/go.mod',g)\n z.writestr(m+'@'+v+'/lib.go',s)",
          join(folder, `${version}.zip`),
          module,
          version,
          goMod,
          source,
        ],
        { encoding: "utf8" },
      );
      if (zip.status !== 0) {
        throw new Error(`fixture zip failed: ${zip.stderr}`);
      }
    }
    await writeFile(
      join(folder, "feature.info"),
      JSON.stringify({
        Version: versions[1] ?? versions[0],
        Time: "2025-01-01T00:00:00Z",
      }),
    );
  }
}
