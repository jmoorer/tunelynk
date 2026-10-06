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

export const EMAIL_MAX_LENGTH = 254;

// Normalized before validation so " A@B.Co " and "a@b.co" are one account.
export const EmailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(EMAIL_MAX_LENGTH));

export const EmailStartRequest = z.object({
  email: EmailAddress,
  returnTo: z.string().optional(),
});
export type EmailStartRequest = z.infer<typeof EmailStartRequest>;

export const EmailVerifyRequest = z.object({
  token: z.string().min(1).max(200),
});
export type EmailVerifyRequest = z.infer<typeof EmailVerifyRequest>;

export const EmailVerifyResponse = z.object({ returnTo: z.string() });
export type EmailVerifyResponse = z.infer<typeof EmailVerifyResponse>;

// Sign-in methods this deployment offers (Apple needs portal setup).
export const AuthProviders = z.object({
  email: z.boolean(),
  apple: z.boolean(),
});
export type AuthProviders = z.infer<typeof AuthProviders>;
