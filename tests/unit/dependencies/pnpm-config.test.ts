import { expect, test } from "bun:test";
import { parsePnpmDirectories } from "../../../src/dependencies/executable";

for (const [field, property] of [
  ["modulesDir", "modulesDirectory"],
  ["virtualStoreDir", "virtualStoreDirectory"],
  ["lockfileDir", "lockDirectory"],
] as const) {
  for (const [ini, yaml] of [
    ["safe", "../outside"],
    ["../outside", "safe"],
  ] as const) {
    test(`pnpm ${field} workspace value supersedes npmrc (${ini} → ${yaml})`, () => {
      const key = field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const resolved = parsePnpmDirectories(
        "/repo/app",
        "/repo/app",
        [`${key}=${ini}`],
        {},
        `packages: []\n${field}: ${yaml}\n`,
      );
      expect(resolved[property]).toBe(
        field === "modulesDir" ? yaml : yaml === "safe" ? "/repo/app/safe" : "/repo/outside",
      );
    });
  }
}
for (const text of ['modules-dir="../outside"', `modules-dir=\${HOME}/outside`]) {
  test(`pnpm ambiguous destination rejects supplied config: ${text}`, () => {
    expect(() => parsePnpmDirectories("/repo", "/repo", [text], {})).toThrow("plain literal directory");
  });
}

test("pnpm config selection orders files, then environment, then workspace", () => {
  expect(
    parsePnpmDirectories("/repo/app", "/repo", ["modules-dir=owner", "modules-dir=member"], {}).modulesDirectory,
  ).toBe("member");
  expect(
    parsePnpmDirectories("/repo/app", "/repo", ["modules-dir=member"], {
      "modules-dir": "environment",
    }).modulesDirectory,
  ).toBe("environment");
  expect(
    parsePnpmDirectories(
      "/repo/app",
      "/repo",
      ["modules-dir=member"],
      { "modules-dir": "environment" },
      "modulesDir: workspace",
    ).modulesDirectory,
  ).toBe("workspace");
});
