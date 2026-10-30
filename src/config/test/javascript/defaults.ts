import type { EcosystemTestPolicy } from "../model";
export const JAVASCRIPT_DEFAULTS: EcosystemTestPolicy = {
  include: ["tests/unit/**/*.test.{js,jsx,ts,tsx}"],
  exclude: ["tests/integration/**"],
  source: {
    include: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
    exclude: [
      "tests/**",
      "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
      "**/*.d.{ts,mts,cts}",
      "**/fixtures/**",
      "**/generated/**",
      "**/*.generated.*",
      "**/*.config.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
      "dist/**",
      "build/**",
      "coverage/**",
    ],
  },
  coverage: {
    enabled: true,
    minimum: 70,
  },
};
