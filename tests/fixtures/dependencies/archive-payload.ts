export function copyArchivePayloads(payloads: ReadonlyMap<string, Uint8Array>) {
  return new Map(
    [...payloads].map(([name, bytes]) => [name, Uint8Array.from(bytes)]),
  );
}
