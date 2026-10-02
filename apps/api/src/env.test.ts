import { describe, expect, it } from "vitest";
import { parseEnv, parseMigrateEnv } from "./env";

const DATABASE_URL = "postgres://tunelynk:tunelynk@localhost:5432/tunelynk";
const SESSION_SECRET = "s".repeat(32);
const base = {
  DATABASE_URL,
  APPLE_TEAM_ID: "TEAM",
  APPLE_KEY_ID: "KEY",
  APPLE_PRIVATE_KEY: "PRIVATE",
  SESSION_SECRET,
  ANTHROPIC_API_KEY: "sk-ant",
};

describe("parseEnv", () => {
  it("parses a minimal environment with defaults", () => {
    expect(parseEnv(base)).toEqual({
      DATABASE_URL,
      PORT: 3000,
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
