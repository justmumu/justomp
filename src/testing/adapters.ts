import { type EcosystemTestPolicy } from "../config/test/model";
import {
  type CoverageTotals,
  type TestIssue,
  type TestMode,
  type TestPreparation,
  type TestSuite,
  type TestSummary,
} from "./model";
import { type TestScope } from "./scope";
import { type TestTarget } from "./targets";
export type TestTools = Record<string, string>;
export interface TestToolContext {
  target: TestTarget;
  tools: TestTools;
  signal: AbortSignal;
}
export interface TestRunContext extends TestToolContext {
  suite?: TestSuite;
  policy: EcosystemTestPolicy;
  scope: TestScope;
  mode: TestMode;
  artifacts: string;
  remainingMs: () => number;
}
export interface NativeTestResult {
  tests: TestSummary;
  coverage?: CoverageTotals;
  errors: TestIssue[];
  executed_files: string[];
  stdout: string;
  stderr: string;
  logs_truncated: boolean;
}
export interface TestAdapter {
  resolve(targets: TestTarget[], signal: AbortSignal): Promise<TestTools>;
  preflight(context: TestToolContext): Promise<void>;
  verify(context: TestToolContext): Promise<boolean>;
  prepare(context: TestToolContext, changes: TestPreparation["changes"]): Promise<void>;
  run(context: TestRunContext): Promise<NativeTestResult>;
}
export type TestAdapters = Partial<Record<import("./model").TestRunner, TestAdapter>>;
