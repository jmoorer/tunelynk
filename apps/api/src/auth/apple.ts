import { loadPrivateKey } from "@tunelynk/connectors";
import {
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";

export const APPLE_ISSUER = "https://appleid.apple.com";
const AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
const TOKEN_URL = "https://appleid.apple.com/auth/token";
const KEYS_URL = "https://appleid.apple.com/auth/keys";
const CLIENT_SECRET_TTL = "5m";
const TOKEN_TIMEOUT_MS = 10_000;

export class AppleSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleSignInError";
  }
}

export type AppleSignInConfig = {
  clientId: string; // Services ID
  teamId: string;
  keyId: string;
  privateKey: string; // same formats as APPLE_PRIVATE_KEY
  redirectUri: string;
};

export type AppleClient = {
  authorizeUrl(args: { state: string; nonce: string }): string;
  exchange(code: string, nonce: string): Promise<{ sub: string }>;
};

export function createAppleClient(
  config: AppleSignInConfig,
  {
    fetch = globalThis.fetch,
    // Caches Apple's keys and refetches on an unknown kid (key rotation).
    keys = createRemoteJWKSet(new URL(KEYS_URL)),
    tokenUrl = TOKEN_URL,
  }: {
    fetch?: typeof globalThis.fetch;
    keys?: JWTVerifyGetKey;
    tokenUrl?: string;
  } = {},
): AppleClient {
  const key = loadPrivateKey(config.privateKey);

  const clientSecret = () =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId })
      .setIssuer(config.teamId)
      .setSubject(config.clientId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt()
      .setExpirationTime(CLIENT_SECRET_TTL)
      .sign(key);

  return {
    // No scope: Apple then allows response_mode=query, so the callback is a
    // GET that carries our SameSite=Lax cookies.
    authorizeUrl({ state, nonce }) {
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        response_mode: "query",
        state,
        nonce,
      });
      return `${AUTHORIZE_URL}?${query}`;
    },

    async exchange(code, nonce) {
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: await clientSecret(),
          code,
          grant_type: "authorization_code",
          redirect_uri: config.redirectUri,
        }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new AppleSignInError(`token endpoint responded ${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as {
        id_token?: unknown;
      } | null;
      if (typeof body?.id_token !== "string") {
        throw new AppleSignInError("token response has no id_token");
      }

      let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
      try {
        ({ payload } = await jwtVerify(body.id_token, keys, {
          issuer: APPLE_ISSUER,
          audience: config.clientId,
          algorithms: ["RS256"],
        }));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new AppleSignInError(`id_token rejected: ${reason}`);
      }
      if (payload.nonce !== nonce) {
        throw new AppleSignInError("id_token nonce mismatch");
      }
      if (typeof payload.sub !== "string" || payload.sub === "") {
        throw new AppleSignInError("id_token has no sub");
      }
      return { sub: payload.sub };
    },
  };
}
