import { parseInventory } from "../../../../src/dependencies/inventory";
import { memoryContext } from "../memory";
export async function fixture(manifest: Record<string, unknown> = {}) {
  const f = memoryContext({
    manager: "yarn",
    managerCandidates: ["yarn"],
    project_id: "javascript:package.json",
  });
  f.context.version = "4.12.0";
  const text = JSON.stringify({
    name: "app",
    packageManager: "yarn@4.12.0",
    ...manifest,
  });
  f.write("package.json", text);
  return {
    ...f,
    inventory: parseInventory(f.context.project, text),
    id: f.context.project.project_id,
    text: async () => text,
  };
}
