import { expect, test } from "bun:test";
import { pythonTestAdapter } from "../../../src/testing/python/adapter";
import { nativeFixture } from "./native-fixture";

test("pytest exact file handoff retains fixtures/pythonpath, failure counts and unused namespace source coverage", async () => {
  const f = await nativeFixture("pytest", pythonTestAdapter);
  try {
    await f.put("src/ns/unused.py", "def unused():\n    return 42\n");
    await f.put("tests/conftest.py", "import pytest\n@pytest.fixture\ndef answer():\n    return 42\n");
    await f.put(
      "tests/test_chosen.py",
      "def test_fail():\n    assert False\ndef test_pass(answer):\n    assert answer == 42\n",
    );
    await f.put("tests/test_unselected.py", 'raise RuntimeError("foreign test executed")\n');
    await f.prepareConfig();
    const full = await f.run(["tests/test_chosen.py"], ["src/ns/unused.py"]);
    expect(full.errors).toEqual([{ code: "test-failed", message: "One or more tests failed" }]);
    expect(full.tests).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(full.coverage).toEqual({ total: 2, covered: 0 });
    await f.put("tests/integration/test_flow.py", "def test_flow(answer):\n    assert answer == 42\n");
    const integration = await f.run(["tests/integration/test_flow.py"], ["src/ns/unused.py"], "full", {
      suite: "integration",
    });
    expect(integration.errors).toEqual([]);
    expect(integration.tests).toMatchObject({ total: 1, passed: 1 });
    expect(integration.coverage).toBeUndefined();
  } finally {
    await f.dispose();
  }
}, 60000);
