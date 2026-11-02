import { type LoadedConfig } from "../config/load";
import { testPolicyKey } from "../config/test/resolve";
import { type Ecosystem } from "../inspect/model";
import { type TestSuite } from "./model";
export function suitePolicies(config: LoadedConfig, ecosystem: Ecosystem, suite: TestSuite) {
  return {
    unit: config.test[ecosystem],
    integration: config.integrationTest[ecosystem],
    suite,
  };
}
export function testingPolicyKey(config: LoadedConfig, ecosystem: Ecosystem) {
  return testPolicyKey({
    unit: config.test[ecosystem],
    integration: config.integrationTest[ecosystem],
  });
}
