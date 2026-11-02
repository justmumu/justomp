import { type PreparationChange } from "../model";
/** Classify an observed native metadata change, including a previously absent file. */
export function metadataChangeKind(
  previous: string | null | undefined,
  after: string | null,
): PreparationChange["kind"] {
  if (after === null) {
    return "removed";
  }
  return previous === null ? "created" : "updated";
}
