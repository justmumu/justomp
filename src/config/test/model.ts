export interface TestPolicyObject {
  [key: string]: unknown;
}
export interface SourcePolicy extends TestPolicyObject {
  include: string[];
  exclude: string[];
}
export interface CoveragePolicy extends TestPolicyObject {
  enabled: boolean;
  minimum: number;
}
export interface EcosystemTestPolicy extends SourcePolicy {
  source: SourcePolicy;
  coverage: CoveragePolicy;
}
export interface TestPolicy extends TestPolicyObject {
  python: EcosystemTestPolicy;
  javascript: EcosystemTestPolicy;
  go: EcosystemTestPolicy;
}
