import { expect, test } from "bun:test";
import { lifecycleFixture } from "./lifecycle-fixture";

test("session root changes release coordinators and subscriptions before packaging ownership", async () => {
  const fixture = lifecycleFixture();
  try {
    expect(fixture.tools.get("project_inspect")?.approval).toBe("write");
    expect(fixture.tools.has("project_integration_test")).toBe(true);
    await fixture.emit("session_start");
    await fixture.ready;
    expect(fixture.events.indexOf("precommit:install")).toBeLessThan(fixture.events.indexOf("prepush:install"));
    expect(fixture.events.indexOf("prepush:install")).toBeLessThan(fixture.events.indexOf("lint:reconcile"));
    await fixture.inspect("/first");
    expect(fixture.events.filter((event) => event.startsWith("packaging:retain:"))).toEqual([
      "packaging:retain:/first",
    ]);
    const result = await fixture.inspect("/second");
    expect(result.details).toMatchObject({ structure: { root: "/second" } });
    const released = fixture.events.indexOf("packaging:release:/first");
    for (const kind of ["lint", "typecheck", "test"]) {
      expect(fixture.events).toContain(`${kind}:release`);
      expect(fixture.events).toContain(`${kind}:unsubscribe`);
      expect(fixture.events).toContain(`${kind}:unsubscribe-progress`);
      expect(fixture.events.indexOf(`${kind}:release`)).toBeLessThan(released);
      expect(fixture.events.indexOf(`${kind}:unsubscribe`)).toBeLessThan(released);
      expect(fixture.events.indexOf(`${kind}:unsubscribe-progress`)).toBeLessThan(released);
    }
    expect(released).toBeLessThan(fixture.events.indexOf("packaging:retain:/second"));
    await fixture.emit("session_shutdown");
    expect(fixture.events.at(-1)).toBe("packaging:release:/second");
    const closed = await fixture.inspect("/second");
    expect(closed.details).toMatchObject({ error: { code: "closed" } });
    expect(fixture.notices).toEqual([]);
  } finally {
    fixture.restore();
  }
});

test("shutdown releases every owner and unsubscribes before reporting a coordinator release failure", async () => {
  const error = new Error("release failed");
  const fixture = lifecycleFixture(error);
  try {
    await fixture.emit("session_start");
    await fixture.ready;
    const shutdown = fixture.emit("session_shutdown");
    await expect(shutdown).rejects.toBeInstanceOf(AggregateError);
    await expect(shutdown).rejects.toMatchObject({ errors: [error] });
    for (const kind of ["lint", "typecheck", "test"]) {
      expect(fixture.events).toContain(`${kind}:release`);
      expect(fixture.events).toContain(`${kind}:unsubscribe`);
      expect(fixture.events).toContain(`${kind}:unsubscribe-progress`);
    }
    expect(fixture.events.at(-1)).toBe("packaging:release:/first");
  } finally {
    fixture.restore();
  }
});
