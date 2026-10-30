import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
/** The caller supplies the approved inventory; this utility never discovers files. */
export async function importAllSources(
  cwd: string,
  files: readonly string[],
  load: (url: string) => Promise<unknown> = (url) => import(url),
  concurrency = 8,
): Promise<{ file: string; message: string }[]> {
  const failures: { file: string; message: string }[] = [];
  let index = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(files.length, Math.max(1, concurrency)) },
      async () => {
        for (;;) {
          const file = files[index++];
          if (file === undefined) return;
          try {
            await load(pathToFileURL(resolve(cwd, file)).href);
          } catch (error) {
            failures.push({
              file,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    ),
  );
  return failures.sort((a, b) => a.file.localeCompare(b.file));
}
