import { type ProcessResult } from "../dependencies/model";
import { type validateMessage } from "./message";
export interface CommitResult {
  success: boolean;
  committed: boolean | null;
  commit_hash: string | null;
  message: string | null;
  cancelled: boolean;
  validation?: Awaited<ReturnType<typeof validateMessage>>;
  native?: ProcessResult;
  repository_status?: string;
  errors: string[];
}
