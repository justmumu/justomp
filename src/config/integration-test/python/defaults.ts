import type { EcosystemTestPolicy } from "../../test/model";
import { PYTHON_DEFAULTS as UNIT_DEFAULTS } from "../../test/python/defaults";
export const PYTHON_DEFAULTS: EcosystemTestPolicy = {
  include: ["tests/integration/**/test_*.py"],
  exclude: ["tests/unit/**"],
  source: structuredClone(UNIT_DEFAULTS.source),
  coverage: { enabled: false, minimum: 0 },
};
