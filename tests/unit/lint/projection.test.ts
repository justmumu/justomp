import { expect, test } from "bun:test";
import { parse } from "smol-toml";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { projectPython } from "../../../src/lint/projections/python";

test("Python projection preserves unrelated bytes including quoted and multiline TOML", () => {
  const before =
    '# top\r\n[project]\r\nname = "sample" # name\r\ndescription = """\r\n[tool.ruff]\r\nnot a table\r\n"""\r\ndependencies = ["requests"]\r\n\r\n[tool."ruff"]\r\nsrc = [ "lib" ] # keep\r\nline-length = 80\r\n[tool.ruff.lint]\r\nselect=["E"]\r\n\r\n[build-system]\r\nrequires = [ "hatchling" ] # keep\r\n';
  const policy = resolveLintConfig().policy.python;
  const output = projectPython(before, policy);
  expect(output).toContain(before.slice(0, before.indexOf('[tool."ruff"]')));
  expect(output).toContain('src = [ "lib" ] # keep\r\n');
  expect(output).toContain(
    '[build-system]\r\nrequires = [ "hatchling" ] # keep\r\n',
  );
  expect((parse(output).tool as { ruff: unknown }).ruff).toEqual({
    ...policy.ruff,
    src: ["lib"],
  });
  expect(projectPython(output, policy)).toBe(output);
});

test("Python narrow editing rejects ambiguous inline containers without mutation", () => {
  expect(() =>
    projectPython(
      '[tool]\nruff = { src = ["lib"], line-length = 80 }\n',
      resolveLintConfig().policy.python,
    ),
  ).toThrow("Inline");
});

for (const [key, value] of [
  ["respect-gitignore", "false"],
  ["include", '["only.py"]'],
  ["extend", '"../other/ruff.toml"'],
  ["preview", "true"],
])
  test(`Python projection rejects project-local ${key} outside the shared policy`, () => {
    const before = `[project]\nname="example"\n[tool.ruff]\n${key}=${value}\n`;
    expect(() =>
      projectPython(before, resolveLintConfig().policy.python),
    ).toThrow("lint.python.ruff");
  });

test("Python root policy owns explicit extra options while source metadata remains local", () => {
  const before =
    '[tool.ruff]\nsrc = [ "lib" ] # keep layout\ntarget-version = "py311" # keep runtime\nexclude=["*"]\n';
  const policy = resolveLintConfig().policy.python;
  policy.ruff.exclude = [];
  const projected = projectPython(before, policy);
  expect(projected).toContain('src = [ "lib" ] # keep layout\n');
  expect(projected).toContain('target-version = "py311" # keep runtime\n');
  expect((parse(projected).tool as { ruff: unknown }).ruff).toEqual({
    ...policy.ruff,
    src: ["lib"],
    "target-version": "py311",
  });
  expect(projectPython(projected, policy)).toBe(projected);
});
