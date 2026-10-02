import { describe, expect, it } from "vitest";
import { loadCliConfig } from "./config";

const base = {
  APPLE_TEAM_ID: "T",
  APPLE_KEY_ID: "K",
  APPLE_PRIVATE_KEY: "P",
  ANTHROPIC_API_KEY: "sk-ant",
};

describe("loadCliConfig", () => {
  it("applies defaults", () => {
    expect(loadCliConfig(base)).toEqual({
      apple: {
        teamId: "T",
        keyId: "K",
        privateKey: "P",
        storefront: "us",
        rps: 8,
        burst: 10,
        concurrency: 4,
      },
      llm: {
        provider: "anthropic",
        apiKey: "sk-ant",
        model: "claude-haiku-4-5",
        maxTokens: 2000,
      },
    });
  });

  it("uses the OpenAI key when LLM_PROVIDER=openai", () => {
    const config = loadCliConfig({
      ...base,
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-oai",
      LLM_MODEL_GUEST: "gpt-4.1-mini",
    });
    expect(config.llm).toMatchObject({
      provider: "openai",
      apiKey: "sk-oai",
      model: "gpt-4.1-mini",
    });
  });

  it("lists every missing variable at once", () => {
    expect(() => loadCliConfig({ LLM_PROVIDER: "openai" })).toThrow(
      "Missing env: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, OPENAI_API_KEY",
    );
  });

  it("rejects an unknown provider and non-positive numbers", () => {
    expect(() => loadCliConfig({ ...base, LLM_PROVIDER: "gemini" })).toThrow(
      'LLM_PROVIDER must be "anthropic" or "openai"',
    );
    expect(() => loadCliConfig({ ...base, APPLE_CATALOG_RPS: "abc" })).toThrow(
      "APPLE_CATALOG_RPS must be a positive number",
    );
  });
});
