import type { InspectionRules } from "../inspect/model";
export const DEFAULT_RULES: InspectionRules = Object.freeze({
  include: Object.freeze(["**/*"]),
  exclude: Object.freeze([
    "**/.*",
    "**/node_modules",
    "**/venv",
    "**/bower_components",
    "**/__pycache__",
    "**/__pypackages__",
  ]),
});
