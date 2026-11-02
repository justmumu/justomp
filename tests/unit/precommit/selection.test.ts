import { expect, test } from "bun:test";
import { type Project } from "../../../src/inspect/model";
import { configConsumers, selectProjects } from "../../../src/precommit/selection";

const project = (id: string, path: string, ecosystem: Project["ecosystem"] = "javascript"): Project => ({
  project_id: id,
  path,
  ecosystem,
  manifest: `${path}/package.json`,
  managerRoot: ".",
  manager: "pnpm",
  managerCandidates: ["pnpm"],
  frameworks: [],
  status: "detected",
  evidence: [],
});
const projects = [
  project("root", "."),
  project("api", "apps/api"),
  project("py", "apps/api", "python"),
  project("web", "apps/web"),
];
test("config impact follows changed ecosystems; unknown fields remain conservative", () => {
  expect(
    configConsumers(
      projects,
      '{"lint":{"python":{},"javascript":{}}}',
      '{"lint":{"python":{"new":true},"javascript":{}}}',
    ),
  ).toEqual(["py"]);
  expect(configConsumers(projects, '{"commit":{}}', '{"commit":{"types":[]}}')).toEqual([]);
  expect(configConsumers(projects, "{}", '{"inspection_rules":{}}')).toEqual(projects.map((p) => p.project_id));
});
const ids = (paths: string[], shared = new Map<string, string[]>()) =>
  selectProjects(projects, paths, shared).map((p) => p.project_id);

test("deepest owners include colocated ecosystems; rename endpoints select both", () => {
  expect(ids(["apps/api/file.ts", "apps/web/file.ts"])).toEqual(["api", "py", "web"]);
  expect(ids(["apps/apiary/file.ts"])).toEqual(["root"]);
  expect(ids([])).toEqual([]);
});
test("shared inputs select actual consumers even outside project directories", () => {
  expect(ids(["locks/pnpm-lock.yaml"], new Map([["locks/pnpm-lock.yaml", ["api", "web"]]]))).toEqual(["api", "web"]);
});
test("unknown manifests and shared config conservatively select current projects", () => {
  expect(ids(["deleted/package.json"])).toEqual(["root", "api", "py", "web"]);
  expect(ids([".justomp/config.json"])).toEqual(["root", "api", "py", "web"]);
});
