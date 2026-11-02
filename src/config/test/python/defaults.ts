import { type EcosystemTestPolicy } from "../model";
export const PYTHON_DEFAULTS: EcosystemTestPolicy = {
  include: ["tests/unit/**/test_*.py"],
  exclude: ["tests/integration/**"],
  source: {
    include: ["**/*.py"],
    exclude: ["tests/**", "**/conftest.py", "**/fixtures/**", "**/generated/**", "**/*_generated.py"],
  },
  coverage: {
    enabled: true,
    minimum: 70,
  },
};
