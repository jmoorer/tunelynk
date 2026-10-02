import { createPrivateKey, type KeyObject, sign } from "node:crypto";

// Accepts base64 of the whole .p8 PEM, a bare base64 PKCS#8 DER body, or raw PEM
// (with real or literal "\n" line breaks).
export function loadPrivateKey(raw: string): KeyObject {
  if (raw.includes("BEGIN PRIVATE KEY")) {
    return createPrivateKey(raw.replace(/\\n/g, "\n"));
  }
  const decoded = Buffer.from(raw.trim(), "base64");
  const text = decoded.toString("utf8");
  if (text.includes("BEGIN PRIVATE KEY")) return createPrivateKey(text);
  return createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
}

export type DeveloperTokenOptions = {
  teamId: string;
  keyId: string;
  privateKey: string;
  ttlSeconds?: number;
  refreshAfterSeconds?: number;
  now?: () => number;
};

export type DeveloperToken = {
  get(): string;
  invalidate(): void;
};

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

export function createDeveloperToken({
  teamId,
  keyId,
  privateKey,
  ttlSeconds = 3600,
  refreshAfterSeconds = 3000,
  now = Date.now,
}: DeveloperTokenOptions): DeveloperToken {
  const key = loadPrivateKey(privateKey);
  let cached: { token: string; signedAt: number } | undefined;

  const signToken = (iat: number) => {
    const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
    const payload = b64url(
      JSON.stringify({ iss: teamId, iat, exp: iat + ttlSeconds }),
    );
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    return `${header}.${payload}.${b64url(signature)}`;
  };

  return {
    get() {
      const nowSeconds = Math.floor(now() / 1000);
      if (!cached || nowSeconds - cached.signedAt >= refreshAfterSeconds) {
        cached = { token: signToken(nowSeconds), signedAt: nowSeconds };
      }
      return cached.token;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
