import { describe, expect, it } from "vitest";
import { parseEnv, parseMigrateEnv } from "./env";

const DATABASE_URL = "postgres://tunelynk:tunelynk@localhost:5432/tunelynk";
const SESSION_SECRET = "s".repeat(32);
const base = {
  DATABASE_URL,
  APP_URL: "http://localhost:5173/",
  EMAIL_PROVIDER: "console",
  APPLE_TEAM_ID: "TEAM",
  APPLE_KEY_ID: "KEY",
  APPLE_PRIVATE_KEY: "PRIVATE",
  SESSION_SECRET,
  ANTHROPIC_API_KEY: "sk-ant",
  APPLE_SIGNIN_CLIENT_ID: "com.bytmoor.tunelynk.web",
};

describe("parseEnv", () => {
  it("parses a minimal environment with defaults", () => {
    expect(parseEnv(base)).toEqual({
      DATABASE_URL,
      PORT: 3000,
      APP_URL: "http://localhost:5173",
      APPLE_TEAM_ID: "TEAM",
      APPLE_KEY_ID: "KEY",
      APPLE_PRIVATE_KEY: "PRIVATE",
      APPLE_STOREFRONT: "us",
      APPLE_CATALOG_RPS: 8,
      APPLE_CATALOG_BURST: 10,
      APPLE_CATALOG_CONCURRENCY: 4,
      SESSION_SECRET,
      COOKIE_SECURE: true,
      LLM_PROVIDER: "anthropic",
      LLM_MODEL_GUEST: "claude-haiku-4-5",
      LLM_API_KEY: "sk-ant",
      LLM_MAX_TOKENS: 2000,
      LLM_DAILY_BUDGET_USD: 2,
      EMAIL: { provider: "console" },
      APPLE_SIGNIN: {
        clientId: "com.bytmoor.tunelynk.web",
        keyId: "KEY",
        privateKey: "PRIVATE",
      },
    });
  });

  it("coerces PORT and treats empty strings as unset", () => {
    const env = parseEnv({ ...base, PORT: "4000", APPLE_STOREFRONT: "" });
    expect(env.PORT).toBe(4000);
    expect(env.APPLE_STOREFRONT).toBe("us");
    expect(parseEnv({ ...base, PORT: "" }).PORT).toBe(3000);
  });

  it("uses the OpenAI key and default model for LLM_PROVIDER=openai", () => {
    const env = parseEnv({
      ...base,
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-oai",
    });
    expect(env.LLM_MODEL_GUEST).toBe("gpt-4.1-mini");
    expect(env.LLM_API_KEY).toBe("sk-oai");
  });

  it("requires APP_URL", () => {
    const { APP_URL: _omit, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(/APP_URL/);
  });

  it("rejects a non-http APP_URL", () => {
    expect(() => parseEnv({ ...base, APP_URL: "ftp://x.co" })).toThrow(
      /APP_URL/,
    );
  });

  it("strips trailing slashes from APP_URL", () => {
    expect(
      parseEnv({ ...base, APP_URL: "https://tunelynk.bytmoor.com//" }).APP_URL,
    ).toBe("https://tunelynk.bytmoor.com");
  });

  it("requires EMAIL_PROVIDER when cookies are secure (production)", () => {
    const { EMAIL_PROVIDER: _omit, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(/EMAIL_PROVIDER/);
  });

  it("defaults EMAIL_PROVIDER to console for local http", () => {
    const { EMAIL_PROVIDER: _omit, ...rest } = base;
    expect(parseEnv({ ...rest, COOKIE_SECURE: "false" }).EMAIL).toEqual({
      provider: "console",
    });
  });

  it("configures Resend when EMAIL_PROVIDER=resend", () => {
    const env = parseEnv({
      ...base,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_123",
      EMAIL_FROM: "Tunelynk <login@bytmoor.com>",
    });
    expect(env.EMAIL).toEqual({
      provider: "resend",
      apiKey: "re_123",
      from: "Tunelynk <login@bytmoor.com>",
    });
    expect(env).not.toHaveProperty("RESEND_API_KEY");
  });

  it.each(["RESEND_API_KEY", "EMAIL_FROM"])(
    "requires %s when EMAIL_PROVIDER=resend",
    (name) => {
      const env = {
        ...base,
        EMAIL_PROVIDER: "resend",
        RESEND_API_KEY: "re_123",
        EMAIL_FROM: "Tunelynk <login@bytmoor.com>",
        [name]: "",
      };
      expect(() => parseEnv(env)).toThrow(new RegExp(name));
    },
  );

  it("turns Apple sign-in off without APPLE_SIGNIN_CLIENT_ID", () => {
    const { APPLE_SIGNIN_CLIENT_ID: _omit, ...rest } = base;
    const env = parseEnv({ ...rest, APPLE_SIGNIN_KEY_ID: "SIWAKEY" });
    expect(env.APPLE_SIGNIN).toBeNull();
    expect(env).not.toHaveProperty("APPLE_SIGNIN_KEY_ID");
  });

  it("uses a separate Sign in with Apple key when given", () => {
    const env = parseEnv({
      ...base,
      APPLE_SIGNIN_KEY_ID: "SIWAKEY",
      APPLE_SIGNIN_PRIVATE_KEY: "SIWAPRIVATE",
    });
    expect(env.APPLE_SIGNIN).toEqual({
      clientId: "com.bytmoor.tunelynk.web",
      keyId: "SIWAKEY",
      privateKey: "SIWAPRIVATE",
    });
    expect(env).not.toHaveProperty("APPLE_SIGNIN_KEY_ID");
  });

  it("parses COOKIE_SECURE=false", () => {
    expect(parseEnv({ ...base, COOKIE_SECURE: "false" }).COOKIE_SECURE).toBe(
      false,
    );
  });

  it.each([
    ["DATABASE_URL", { ...base, DATABASE_URL: "not-a-url" }],
    ["APPLE_TEAM_ID", { ...base, APPLE_TEAM_ID: undefined }],
    ["SESSION_SECRET", { ...base, SESSION_SECRET: "short" }],
    ["OPENAI_API_KEY", { ...base, LLM_PROVIDER: "openai" }],
    ["LLM_MODEL_GUEST", { ...base, LLM_MODEL_GUEST: "gpt-5-mini" }],
    ["LLM_PROVIDER", { ...base, LLM_PROVIDER: "gemini" }],
    ["APPLE_CATALOG_RPS", { ...base, APPLE_CATALOG_RPS: "abc" }],
    [
      "APPLE_CATALOG_CONCURRENCY",
      { ...base, APPLE_CATALOG_CONCURRENCY: "1.5" },
    ],
    ["LLM_DAILY_BUDGET_USD", { ...base, LLM_DAILY_BUDGET_USD: "0" }],
    ["COOKIE_SECURE", { ...base, COOKIE_SECURE: "yes" }],
  ])("fails naming %s", (name, source) => {
    expect(() => parseEnv(source)).toThrow(name);
  });

  it.each(["abc", "0", "70000", "3000.5"])(
    "fails naming PORT for %s",
    (PORT) => {
      expect(() => parseEnv({ ...base, PORT })).toThrow(/PORT/);
    },
  );
});

describe("parseMigrateEnv", () => {
  it("needs only DATABASE_URL", () => {
    expect(parseMigrateEnv({ DATABASE_URL })).toEqual({ DATABASE_URL });
  });

  it("fails naming DATABASE_URL", () => {
    expect(() => parseMigrateEnv({})).toThrow(/DATABASE_URL/);
  });
});
