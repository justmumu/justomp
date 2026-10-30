import { memoryContext } from "../memory";

export async function uvFixture(dependencies = '"uv-demo>=1,<2"') {
  const f = memoryContext({
    project_id: "python:pyproject.toml",
    manifest: "pyproject.toml",
    ecosystem: "python",
    name: "uv-app",
    manager: "uv",
    managerCandidates: ["uv"],
  });
  f.context.version = "0.11.6";
  f.write(
    "pyproject.toml",
    `[project]\nname="uv-app"\nversion="1.0.0"\ndependencies=[${dependencies}]\n[tool.uv]\npackage=false\n`,
  );
  return {
    ...f,
    dispose: f.close,
    manifest: async () => f.files.get(`${f.root}/pyproject.toml`) ?? "",
  };
}
