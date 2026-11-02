import { type InspectionRules } from "./model";
export const INSPECTION_DEFAULTS: InspectionRules = Object.freeze({
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
