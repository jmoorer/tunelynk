import { z } from "zod";

export const MeUser = z.object({
  id: z.uuid(),
  isGuest: z.boolean(),
  // Email address, "Apple ID", or null for guests.
  label: z.string().nullable(),
});
export type MeUser = z.infer<typeof MeUser>;

export const MeResponse = z.object({ user: MeUser.nullable() });
export type MeResponse = z.infer<typeof MeResponse>;
