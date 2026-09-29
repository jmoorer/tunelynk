import { z } from "zod";

export const HealthResponse = z.object({
  ok: z.boolean(),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
