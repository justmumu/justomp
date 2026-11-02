import { expect, spyOn, test } from "bun:test";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { pythonAdapter } from "../../../src/typecheck/adapters/python";
import { suppliedResponse } from "../../response";
import { target } from "../checks/fixture";

const VERSION = "1.1.414";
function fixture(multiple = false) {
  const selected = target("python");
  const other = structuredClone(selected);
  other.project.project_id = "python:other/pyproject.toml";
  return {
    targets: multiple ? [selected, other] : [selected],
    context: {
      policy: resolveTypecheckConfig().policy,
      signal: new AbortController().signal,
    },
  };
}
test("PyPI resolution uses one latest stable non-yanked exact target for the whole wave", async () => {
  const f = fixture(true);
  let requests = 0;
  const original = globalThis.fetch;
  const mocked = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () => {
        return suppliedResponse(() => {
          requests++;
          return Response.json({
            releases: {
              "1.1.413": [{ yanked: false }],
              [VERSION]: [{ yanked: false }],
              "1.1.415rc1": [{ yanked: false }],
              "1.1.416": [{ yanked: true }],
            },
          });
        });
      },
      { preconnect: original.preconnect },
    ),
  );
  try {
    expect(Object.values(await pythonAdapter.resolve(f.targets, f.context.policy, f.context.signal))).toEqual(
      f.targets.map(() => ({ pyright: VERSION })),
    );
    expect(requests).toBe(1);
  } finally {
    mocked.mockRestore();
  }
});
test("registry failure keeps typecheck error identity", async () => {
  const f = fixture();
  const original = globalThis.fetch;
  const mocked = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => new Response("unavailable", { status: 503 }), {
      preconnect: original.preconnect,
    }),
  );
  try {
    await expect(pythonAdapter.resolve(f.targets, f.context.policy, f.context.signal)).rejects.toMatchObject({
      code: "version-resolution-failed",
    });
  } finally {
    mocked.mockRestore();
  }
});
