import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeveloperToken, loadPrivateKey } from "./devToken";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const base64Pem = Buffer.from(pem).toString("base64");
const base64Der = privateKey
  .export({ type: "pkcs8", format: "der" })
  .toString("base64");

const decode = (part: string | undefined) =>
  JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));

function verifies(token: string): boolean {
  const [header, payload, signature] = token.split(".");
  return verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature ?? "", "base64url"),
  );
}

describe("loadPrivateKey", () => {
  it.each([
    ["raw PEM", pem],
    ["PEM with literal \\n", pem.replace(/\n/g, "\\n")],
    ["base64 of the PEM", base64Pem],
    ["base64 PKCS#8 DER", base64Der],
  ])("accepts %s", (_label, raw) => {
    expect(loadPrivateKey(raw).asymmetricKeyType).toBe("ec");
  });

  it("throws on garbage", () => {
    expect(() => loadPrivateKey("not a key")).toThrow();
  });
});

describe("createDeveloperToken", () => {
  const options = {
    teamId: "TEAM123",
    keyId: "KEY456",
    privateKey: base64Pem,
  };

  it("signs an ES256 JWT with the Apple claims", () => {
    const now = () => 1_700_000_000_000;
    const token = createDeveloperToken({ ...options, now }).get();
    const [header, payload] = token.split(".");
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY456" });
    expect(decode(payload)).toEqual({
      iss: "TEAM123",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(verifies(token)).toBe(true);
  });

  it("reuses the token for 50 minutes, then re-signs", () => {
    let nowMs = 1_700_000_000_000;
    const token = createDeveloperToken({ ...options, now: () => nowMs });
    const first = token.get();

    nowMs += 2999 * 1000;
    expect(token.get()).toBe(first);

    nowMs += 1000; // 3000 s after signing
    const second = token.get();
    expect(second).not.toBe(first);
    expect(decode(second.split(".")[1]).iat).toBe(1_700_003_000);
  });

  it("re-signs after invalidate()", () => {
    let nowMs = 1_700_000_000_000;
    const token = createDeveloperToken({ ...options, now: () => nowMs });
    token.get();
    nowMs += 1000;
    token.invalidate();
    expect(decode(token.get().split(".")[1]).iat).toBe(1_700_000_001);
  });

  it("fails at construction on a bad key", () => {
    expect(() =>
      createDeveloperToken({ ...options, privateKey: "bad" }),
    ).toThrow();
  });
});
