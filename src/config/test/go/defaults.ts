import type { EcosystemTestPolicy } from "../model";
export const GO_DEFAULTS: EcosystemTestPolicy = {
  include: ["**/*_test.go"],
  exclude: ["tests/integration/**", "**/*_integration_test.go"],
  source: {
    include: ["**/*.go"],
    exclude: [
      "**/*_test.go",
      "**/testdata/**",
      "**/generated/**",
      "**/*.generated.go",
      "**/*.pb.go",
    ],
  },
  coverage: {
    enabled: true,
    minimum: 70,
  },
};
