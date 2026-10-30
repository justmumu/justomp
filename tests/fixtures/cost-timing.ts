import { appendFile } from "node:fs/promises";
/** Opt-in timing for fixture work; production tool execution is never intercepted. */
export async function measureFixture<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await operation();
  } finally {
    const path = process.env.JUSTOMP_TEST_TIMINGS;
    if (path)
      await appendFile(
        path,
        `${JSON.stringify({ stage, seconds: (performance.now() - start) / 1000 })}\n`,
      );
  }
}
