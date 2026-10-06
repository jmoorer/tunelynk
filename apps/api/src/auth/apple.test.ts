import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AppleSignInError, createAppleClient } from "./apple";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherRsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

const config = {
  clientId: "com.bytmoor.tunelynk.web",
  teamId: "TEAM123",
  keyId: "KEY123",
  privateKey: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  redirectUri: "https://tunelynk.test/api/auth/apple/callback",
};

let keys: JWTVerifyGetKey;
beforeAll(async () => {
  keys = createLocalJWKSet({
    keys: [
      {
        ...(await exportJWK(rsa.publicKey)),
        kid: "apple-1",
        alg: "RS256",
        use: "sig",
      },
    ],
  });
});

const now = () => Math.floor(Date.now() / 1000);

const idToken = ({
  nonce = "n-1",
  aud = config.clientId,
  iss = "https://appleid.apple.com",
  sub = "001234.abc",
  kid = "apple-1",
  key = rsa.privateKey as KeyObject,
  exp = now() + 300,
}: Partial<{
  nonce: string;
  aud: string;
  iss: string;
  sub: string;
  kid: string;
  key: KeyObject;
  exp: number;
}> = {}) =>
  new SignJWT({ nonce })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt(exp - 600)
    .setExpirationTime(exp)
    .sign(key);

const tokenEndpoint = (body: unknown, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

describe("createAppleClient", () => {
  it("builds the authorize URL without scopes", () => {
    const url = new URL(
      createAppleClient(config, { keys }).authorizeUrl({
        state: "s-1",
        nonce: "n-1",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://appleid.apple.com/auth/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      response_mode: "query",
      state: "s-1",
      nonce: "n-1",
    });
  });

  it("exchanges the code with an ES256 client secret and returns sub", async () => {
    const fetch = tokenEndpoint({ id_token: await idToken() });
    const result = await createAppleClient(config, { keys, fetch }).exchange(
      "code-1",
      "n-1",
    );
    expect(result).toEqual({ sub: "001234.abc" });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://appleid.apple.com/auth/token");
    expect(init.method).toBe("POST");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("client_id")).toBe(config.clientId);
    expect(form.get("code")).toBe("code-1");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(config.redirectUri);

    const secret = form.get("client_secret") ?? "";
    expect(decodeProtectedHeader(secret)).toEqual({
      alg: "ES256",
      kid: "KEY123",
    });
    const { payload } = await jwtVerify(secret, ec.publicKey, {
      issuer: "TEAM123",
      audience: "https://appleid.apple.com",
      subject: config.clientId,
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  it.each([
    ["wrong audience", () => idToken({ aud: "com.other.app" })],
    ["wrong issuer", () => idToken({ iss: "https://evil.example" })],
    ["expired", () => idToken({ exp: now() - 60 })],
    ["nonce mismatch", () => idToken({ nonce: "n-other" })],
    ["empty sub", () => idToken({ sub: "" })],
    ["unknown kid (rotated keys)", () => idToken({ kid: "apple-2" })],
    ["right kid, wrong key", () => idToken({ key: otherRsa.privateKey })],
  ])("rejects an id_token with %s", async (_label, make) => {
    const fetch = tokenEndpoint({ id_token: await make() });
    await expect(
      createAppleClient(config, { keys, fetch }).exchange("code-1", "n-1"),
    ).rejects.toBeInstanceOf(AppleSignInError);
  });

  it("rejects a non-2xx token response", async () => {
    const fetch = tokenEndpoint({ error: "invalid_grant" }, 400);
    await expect(
      createAppleClient(config, { keys, fetch }).exchange("code-1", "n-1"),
    ).rejects.toThrow(/400/);
  });

  it("rejects a response without an id_token", async () => {
    const fetch = tokenEndpoint({ access_token: "x" });
    await expect(
      createAppleClient(config, { keys, fetch }).exchange("code-1", "n-1"),
    ).rejects.toBeInstanceOf(AppleSignInError);
  });
});
