import { type Stats } from "node:fs";
import { statfs } from "node:fs/promises";
import { relative, sep } from "node:path";
import { FSWatcher } from "chokidar";
import { type InspectionRules } from "../config/inspection/model";
import { createMatcher, type InspectionMatcher, isDiscoveryInput } from "../inspect/exclusions";
export interface WatchStatus {
  ready: boolean;
  healthy: boolean;
  revision: number;
  reason?: string;
  watchedPaths: string[];
}
// Only local filesystem families with native notification support are eligible.
const LOCAL_FS: Record<string, readonly number[]> = {
  darwin: [0x1a, 0x11],
  linux: [0xef53, 0x01021994, 0x58465342, 0x9123683e],
};
function signature(s: Stats): string {
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode].join(":");
}
export class StructureWatcher {
  revision = 0;
  ready: boolean = false;
  reason: string | undefined;
  private watcher: FSWatcher | undefined;
  private stopped: boolean = false;
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    this.revision++;
    for (const listener of this.listeners) {
      listener();
    }
  }
  private fingerprints = new Map<string, string>();
  constructor(
    readonly root: string,
    readonly rules: InspectionRules,
  ) {}
  get healthy() {
    return this.ready && !this.stopped && !this.reason && this.watcher !== undefined && !this.watcher.closed;
  }
  lose(reason: string) {
    this.reason = reason;
    this.changed();
  }
  status(): WatchStatus {
    return {
      ready: this.ready,
      healthy: this.healthy,
      revision: this.revision,
      ...(this.reason ? { reason: this.reason } : {}),
      watchedPaths: this.watcher
        ? Object.keys(this.watcher.getWatched())
            .map((p) => relative(this.root, p).split(sep).join("/") || ".")
            .filter((p) => p !== ".." && !p.startsWith("../"))
            .sort()
        : [],
    };
  }
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const poll = process.env.CHOKIDAR_USEPOLLING?.toLowerCase();
    if (poll && poll !== "0" && poll !== "false") {
      this.lose("Native watcher disabled: CHOKIDAR_USEPOLLING requests polling");
      return;
    }
    try {
      const fs = await statfs(this.root);
      if (!LOCAL_FS[process.platform]?.includes(Number(fs.type))) {
        this.lose(`Unverified filesystem ${fs.type} on ${process.platform}; full inspection required`);
        return;
      }
    } catch (error: unknown) {
      this.lose(`Cannot establish filesystem coverage: ${filesystemError(error)}`);
      return;
    }
    signal.throwIfAborted();
    const matcher = createMatcher(this.rules);
    const local = (p: string) => relative(this.root, p).split(sep).join("/") || ".";
    const watcher = new FSWatcher({
      backend: "native",
      usePolling: false,
      followSymlinks: false,
      ignoreInitial: true,
      ignorePermissionErrors: false,
      atomic: false,
      awaitWriteFinish: false,
      persistent: false,
      ignored: (path, stats) => this.ignored(local(path), stats, matcher),
    });
    this.watcher = watcher;
    watcher.on("all", (event, path, stats) => this.event(event, local(path), stats, matcher));
    watcher.on("error", (error) =>
      this.lose(`Watcher error: ${error instanceof Error ? error.message : String(error)}`),
    );
    watcher.on("raw", (event) => {
      if (/overflow|IN_Q_OVERFLOW/i.test(event)) {
        this.lose(`Watcher coverage lost: ${event}`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        signal.removeEventListener("abort", abort);
        watcher.off("ready", ready);
        watcher.off("error", failed);
      };
      const abort = () => {
        clean();
        reject(signal.reason);
      };
      const ready = () => {
        clean();
        this.ready = true;
        resolve();
      };
      const failed = () => {
        clean();
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      watcher.once("ready", ready);
      watcher.once("error", failed);
      watcher.add(this.root);
      if (signal.aborted) {
        abort();
      }
    });
    if (this.reason) {
      await watcher.close();
    }
  }
  private ignored(p: string, stats: Stats | undefined, matcher: InspectionMatcher): boolean {
    if (p === ".") {
      return false;
    }
    if (p === ".." || p.startsWith("../")) {
      return true;
    }
    if (matcher.excludes(p) || stats?.isSymbolicLink()) {
      return true;
    }
    if (stats?.isFile()) {
      return this.ignoredFile(p, stats, matcher);
    }
    return !matcher.mayTraverse(p) && !matcher.includes(p);
  }
  private ignoredFile(p: string, stats: Stats, matcher: InspectionMatcher): boolean {
    const ignored = !matcher.includes(p) || !isDiscoveryInput(p);
    if (!ignored && !this.ready) {
      this.fingerprints.set(p, signature(stats));
    }
    return ignored;
  }
  private unchanged(event: string, p: string, stats: Stats | undefined): boolean {
    if (event === "unlink") {
      this.fingerprints.delete(p);
    }
    if (stats?.isFile() && isDiscoveryInput(p)) {
      const next = signature(stats),
        previous = this.fingerprints.get(p);
      this.fingerprints.set(p, next);
      // macOS can report reads as changes; atime alone is not a discovery input.
      if (event === "change" && previous === next) {
        return true;
      }
    }
    return false;
  }
  private event(event: string, p: string, stats: Stats | undefined, matcher: InspectionMatcher): void {
    if (matcher.excludes(p)) {
      return;
    }
    if (this.unchanged(event, p, stats)) {
      return;
    }
    if (
      event === "addDir" || event === "unlinkDir" ? matcher.mayTraverse(p) : matcher.includes(p) && isDiscoveryInput(p)
    ) {
      this.changed();
    }
  }
  async close() {
    this.stopped = true;
    await this.watcher?.close();
    this.fingerprints.clear();
    this.listeners.clear();
  }
}

function filesystemError(error: unknown): string {
  return String(error);
}
