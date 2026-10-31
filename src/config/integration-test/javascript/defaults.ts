import { JAVASCRIPT_DEFAULTS as UNIT_DEFAULTS } from "../../test/javascript/defaults";
import type { EcosystemTestPolicy } from "../../test/model";
export const JAVASCRIPT_DEFAULTS: EcosystemTestPolicy = {
  include: ["tests/integration/**/*.test.{js,jsx,ts,tsx}"],
  exclude: ["tests/unit/**"],
  source: structuredClone(UNIT_DEFAULTS.source),
  coverage: { enabled: false, minimum: 0 },
};
