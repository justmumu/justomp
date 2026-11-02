import picomatch from "picomatch";

/** Project-relative source entry selection; imports can still reach excluded files. */
export function excludeSourceFiles(files: readonly string[], exclude: readonly string[]): string[] {
  const excluded = picomatch([...exclude], { dot: true });
  return files.filter((file) => !excluded(file));
}
