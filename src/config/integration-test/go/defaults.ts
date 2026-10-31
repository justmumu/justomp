import { GO_DEFAULTS as UNIT_DEFAULTS } from "../../test/go/defaults";
import type { EcosystemTestPolicy } from "../../test/model";
export const GO_DEFAULTS: EcosystemTestPolicy = {
  include: ["**/*_integration_test.go"],
  exclude: [],
  source: structuredClone(UNIT_DEFAULTS.source),
  coverage: { enabled: false, minimum: 0 },
};
