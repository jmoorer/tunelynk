import { createHash, randomBytes } from "node:crypto";

// Session and login tokens: 32 random bytes, URL- and cookie-safe.
export const newToken = (): string => randomBytes(32).toString("base64url");

// Only the hash is stored, so a database leak does not leak live tokens.
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
