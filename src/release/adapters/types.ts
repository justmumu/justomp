import { type AdapterContext, type NativeStep } from "../../dependencies/model";
import { type FileSnapshot } from "../../lint/files";
import { type NativeLockSnapshot } from "../native-evidence";
import { type NativeReferenceEvidence } from "../references";
import { type ReleaseRepository } from "../repository";
export interface ReleaseMetadataFile {
  path: string;
  before: FileSnapshot;
  content: string;
}
export interface ReleaseOwner {
  context: AdapterContext;
  command: string;
  steps: NativeStep[];
  lockBefore: NativeLockSnapshot;
}
export interface NativeReleasePlan {
  repo: ReleaseRepository;
  target: string;
  files: ReleaseMetadataFile[];
  owners: ReleaseOwner[];
  references: NativeReferenceEvidence[];
  expected: Map<string, Record<string, unknown>>;
}
