/** Shared policy retains unknown fields for native options and future versions. */
export interface TypecheckPolicyObject {
  [key: string]: unknown;
}
export type DiagnosticLevel =
  | "none"
  | "information"
  | "warning"
  | "error"
  | boolean;
export interface PythonTypecheckPolicy extends TypecheckPolicyObject {
  pyright: TypecheckPolicyObject & {
    typeCheckingMode: "off" | "basic" | "standard" | "strict";
    diagnostics: Record<string, DiagnosticLevel>;
  };
}
export interface JavascriptTypecheckPolicy extends TypecheckPolicyObject {
  compilerOptions: TypecheckPolicyObject & {
    strict: boolean;
    allowJs: boolean;
    checkJs: boolean;
    noUncheckedIndexedAccess: boolean;
    exactOptionalPropertyTypes: boolean;
    noImplicitOverride: boolean;
    skipLibCheck: boolean;
  };
}
export interface GoTypecheckPolicy extends TypecheckPolicyObject {
  build_tags: string[];
}
export interface TypecheckPolicy extends TypecheckPolicyObject {
  python: PythonTypecheckPolicy;
  javascript: JavascriptTypecheckPolicy;
  go: GoTypecheckPolicy;
}
