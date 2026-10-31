import { resolveTestPolicy } from "../test/resolve";
import { GO_DEFAULTS } from "./go/defaults";
import { JAVASCRIPT_DEFAULTS } from "./javascript/defaults";
import { PYTHON_DEFAULTS } from "./python/defaults";
export function resolveIntegrationTestConfig(value?: unknown) {
  return resolveTestPolicy(
    value,
    {
      python: PYTHON_DEFAULTS,
      javascript: JAVASCRIPT_DEFAULTS,
      go: GO_DEFAULTS,
    },
    "integration_test",
  );
}
