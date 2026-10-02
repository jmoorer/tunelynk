import { describe, expect, it } from "vitest";
import { createLlmProvider } from "./index";

describe("createLlmProvider", () => {
  it("builds the configured provider", () => {
    const anthropic = createLlmProvider({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-haiku-4-5",
      maxTokens: 2000,
    });
    const openai = createLlmProvider({
      provider: "openai",
      apiKey: "k",
      model: "gpt-4.1-mini",
      maxTokens: 2000,
    });
    expect(anthropic.model).toBe("claude-haiku-4-5");
    expect(openai.model).toBe("gpt-4.1-mini");
  });

  it("fails fast for an unpriced model", () => {
    expect(() =>
      createLlmProvider({
        provider: "openai",
        apiKey: "k",
        model: "gpt-unknown",
        maxTokens: 2000,
      }),
    ).toThrow(/No price/);
  });
});
