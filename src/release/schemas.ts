import { z } from "@oh-my-pi/omptype/zod";
export const releaseSchemas = {
  changelog: z.object({}).strict(),
  bump: z.object({ increment: z.enum(["patch", "minor", "major"]) }).strict(),
  tag: z.object({}).strict(),
};
export type Increment = z.infer<typeof releaseSchemas.bump>["increment"];
