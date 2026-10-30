import { TestError } from "./model";
/** A single monotonic budget begins after preparation and is shared by every phase. */
export function testDeadline(seconds: number, caller?: AbortSignal) {
  const controller = new AbortController();
  const end = performance.now() + seconds * 1000;
  let timer: ReturnType<typeof setTimeout>;
  const remainingMs = () => Math.max(0, Math.ceil(end - performance.now()));
  const expire = () => {
    const remaining = remainingMs();
    if (remaining > 0)
      timer = setTimeout(expire, Math.min(remaining, 2147483647));
    else
      controller.abort(
        new TestError("timeout", "Project tests exceeded timeout_seconds"),
      );
  };
  const cancel = () =>
    controller.abort(new TestError("cancelled", "Project test call cancelled"));
  timer = setTimeout(expire, Math.min(remainingMs(), 2147483647));
  caller?.addEventListener("abort", cancel, { once: true });
  if (caller?.aborted) cancel();
  return {
    signal: controller.signal,
    remainingMs,
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", cancel);
    },
  };
}
