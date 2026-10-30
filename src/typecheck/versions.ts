import type { ToolVersions } from "./adapters/types";
import { TypecheckError } from "./model";

export function stableVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value))
    throw new TypecheckError(
      "invalid-version",
      "Expected an exact stable major.minor.patch tool version",
    );
  return value;
}
export function validateToolVersions(value: unknown): ToolVersions {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.keys(value).length
  )
    throw new TypecheckError(
      "invalid-version",
      "Resolved tool versions must be a nonempty map",
    );
  for (const version of Object.values(value)) stableVersion(version);
  return value as ToolVersions;
}
export { sameVersions } from "../lint/versions";
/** Bounded registry metadata read shared by native resolvers; no retry or latest timer. */
export async function fetchVersionJSON(
  url: string,
  signal: AbortSignal,
  accept = "application/json",
): Promise<unknown> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const response = await fetch(url, {
    signal: bounded,
    headers: { Accept: accept },
  });
  if (!response.ok)
    throw new TypecheckError(
      "version-resolution-failed",
      `Version registry returned HTTP ${response.status}`,
    );
  const reader = response.body?.getReader();
  if (!reader)
    throw new TypecheckError(
      "version-resolution-failed",
      "Version registry returned no body",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024)
        throw new TypecheckError(
          "version-resolution-failed",
          "Version registry metadata exceeds 8 MiB",
        );
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}
