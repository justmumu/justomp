import { basename, dirname, resolve } from "node:path";
import { type JavascriptConfigNode } from "./config-graph";

export function buildConfigPath(path: string): string {
  return path.replace(/\.json$/, ".build.json");
}
export function typesConfigPath(path: string): string {
  return path.replace(/(?:\.build)?\.json$/, ".types.json");
}
/** A native check entry inherits the production build context it exposes to users. */
export function inheritedBuild(node: JavascriptConfigNode): string | undefined {
  const parent = node.raw.extends;
  if (node.compilerOptions.emitDeclarationOnly === true) {
    return undefined;
  }
  return typeof parent === "string" && parent.startsWith(".") && basename(parent).endsWith(".build.json")
    ? resolve(dirname(node.path), parent)
    : undefined;
}
export function declarationNode(node: JavascriptConfigNode, nodes: JavascriptConfigNode[]): JavascriptConfigNode {
  const build = nodes.find((candidate) => candidate.path === inheritedBuild(node)) ?? node;
  const types = nodes.find((candidate) => {
    const parent = candidate.raw.extends;
    return (
      candidate.path === typesConfigPath(build.path) &&
      typeof parent === "string" &&
      resolve(dirname(candidate.path), parent) === build.path &&
      candidate.compilerOptions.emitDeclarationOnly === true
    );
  });
  return types ?? build;
}
export function nativeBuildNodes(nodes: JavascriptConfigNode[]): Set<string> {
  const result = new Set<string>();
  for (const node of nodes) {
    const build = inheritedBuild(node);
    if (build) {
      result.add(build);
    }
    const declaration = declarationNode(node, nodes);
    if (declaration.path !== node.path) {
      result.add(declaration.path);
    }
  }
  return result;
}
