import { posix } from "node:path";
import { type Ecosystem } from "./model";

export function projectId(ecosystem: Ecosystem, manifest: string): string {
  return `${ecosystem}:${posix.normalize(manifest)}`;
}
