import { type ProcessResult } from "../dependencies/model";

/** HEAD can advance independently after Git exits; only its announced object
 * identifies this call. Unknown is deliberately distinct from no commit. */
export function classifyCommit(
  before: string | null,
  after: string | null,
  native: Pick<ProcessResult, "exit_code" | "cancelled" | "stdout">,
): boolean | null {
  const announced = /^\[[^\n]+ ([a-f0-9]{4,64})\]/m.exec(native.stdout)?.[1];
  if (after && after !== before && announced && after.startsWith(announced)) {
    return true;
  }
  if (after === before && !announced && native.exit_code !== 0 && !native.cancelled) {
    return false;
  }
  return null;
}
