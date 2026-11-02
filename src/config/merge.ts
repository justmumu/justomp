/** Merge structural defaults without changing user-owned map or array semantics. */
export function mergeFields(
  supplied: Record<string, unknown>,
  fallback: object,
  path: string,
  merge: (input: unknown, fallback: unknown, path: string) => unknown,
): Record<string, unknown> {
  const result = structuredClone(supplied);
  for (const [key, value] of Object.entries(fallback)) {
    result[key] = merge(Object.hasOwn(supplied, key) ? supplied[key] : undefined, value, `${path}.${key}`);
  }
  return result;
}
