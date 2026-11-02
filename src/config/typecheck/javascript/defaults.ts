import { type JavascriptTypecheckPolicy } from "../model";

export const JAVASCRIPT_DEFAULTS: JavascriptTypecheckPolicy = {
  exclude: [],
  compilerOptions: {
    strict: true,
    allowJs: true,
    checkJs: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    skipLibCheck: false,
  },
};
