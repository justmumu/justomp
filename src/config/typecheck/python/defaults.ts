import { type PythonTypecheckPolicy } from "../model";

export const PYTHON_DEFAULTS: PythonTypecheckPolicy = {
  pyright: {
    typeCheckingMode: "strict",
    diagnostics: {
      reportImplicitOverride: "error",
      reportUnnecessaryTypeIgnoreComment: "error",
      reportMissingTypeStubs: "error",
    },
  },
};
