import { z } from "@oh-my-pi/pi-coding-agent";

const text = z
  .string()
  .min(1)
  .refine(
    (v) => [...v].every((character) => character.charCodeAt(0) >= 32),
    "Control characters are not allowed",
  );
const name = text
  .regex(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((v) => !v.split("/").includes(".."), "Invalid package name");
export const groupSchema = z.union([
  z.object({ kind: z.enum(["runtime", "dev", "optional", "peer"]) }).strict(),
  z
    .object({
      kind: z.enum(["named", "extra"]),
      name: text.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    })
    .strict(),
]);
const source = z.union([
  z.object({ kind: z.literal("registry") }).strict(),
  z
    .object({
      kind: z.literal("git"),
      url: text,
      ref: text.refine((v) => !v.startsWith("-"), "Invalid Git ref"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("path"),
      path: text.refine(
        (v) =>
          !v.startsWith("/") &&
          !v.includes("\\") &&
          !v.split("/").includes(".."),
        "Path must stay relative to the inspection root",
      ),
    })
    .strict(),
  z.object({ kind: z.literal("workspace"), target_project_id: text }).strict(),
]);
const version = text.regex(
  /^v?\d+(?:\.\d+)+(?:[A-Za-z0-9.+-]*)$/,
  "Expected one exact release version",
);
const target = { project_id: text };
const updateItem = z
  .object({ name, version: version.optional(), group: groupSchema.optional() })
  .strict();
const addItem = z
  .object({
    name,
    version: text
      .refine(
        (v) => !v.startsWith("-") && !/[\r\n@/\\]/.test(v),
        "Invalid version constraint",
      )
      .optional(),
    source,
  })
  .strict()
  .refine(
    (v) => v.source.kind === "registry" || v.version === undefined,
    "Only registry additions accept version; use Git ref or local identity",
  );
function unique(
  items: { name: string; group?: z.infer<typeof groupSchema> }[],
): boolean {
  return (
    new Set(items.map((p) => `${p.name}:${JSON.stringify(p.group ?? null)}`))
      .size === items.length
  );
}
export const schemas = {
  projects: z.object({}).strict(),
  list: z
    .object({ ...target, include_transitive: z.boolean().optional() })
    .strict(),
  add: z
    .object({
      ...target,
      group: groupSchema,
      packages: z.array(addItem).min(1).refine(unique, "Duplicate package"),
    })
    .strict(),
  remove: z
    .object({
      ...target,
      group: groupSchema,
      packages: z
        .array(z.object({ name }).strict())
        .min(1)
        .refine(unique, "Duplicate package"),
    })
    .strict(),
  update: z
    .object({
      ...target,
      packages: z
        .array(updateItem)
        .min(1)
        .refine(unique, "Duplicate dependency occurrence"),
      mode: z.enum(["within_constraints", "latest"]).optional(),
    })
    .strict()
    .refine(
      (v) =>
        v.mode === undefined ||
        v.packages.every((p) => p.version === undefined),
      "Explicit mode and version cannot coexist",
    ),
  sync: z.object({ ...target, check: z.boolean().optional() }).strict(),
};
export type Group = z.infer<typeof groupSchema>;
export type Source = z.infer<typeof source>;
export type Operation = Exclude<keyof typeof schemas, "projects">;
export type DependencyRequest = {
  [K in Operation]: z.infer<(typeof schemas)[K]> & { operation: K };
}[Operation];
export function parseRequest(
  operation: Operation,
  input: unknown,
): DependencyRequest {
  return { ...schemas[operation].parse(input), operation } as DependencyRequest;
}
