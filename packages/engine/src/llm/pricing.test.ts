import { describe, expect, it } from "vitest";
import { assertPricedModel, costMicros } from "./pricing";

describe("costMicros", () => {
  it("prices Claude Haiku 4.5 at $1 / $5 per MTok", () => {
    expect(
      costMicros({
        model: "claude-haiku-4-5",
        inputTokens: 1000,
        outputTokens: 2000,
      }),
    ).toBe(11_000); // $0.011
  });

  it("rounds fractional micro-dollars", () => {
    expect(
      costMicros({ model: "gpt-5-mini", inputTokens: 3, outputTokens: 0 }),
    ).toBe(1); // 0.75 → 1
  });

  it("throws for an unknown model", () => {
    expect(() =>
      costMicros({ model: "mystery", inputTokens: 1, outputTokens: 1 }),
    ).toThrow(/No price for LLM model "mystery"/);
  });
});

describe("assertPricedModel", () => {
  it("accepts priced models", () => {
    expect(() => assertPricedModel("claude-haiku-4-5")).not.toThrow();
    expect(() => assertPricedModel("gpt-4.1-mini")).not.toThrow();
  });

  it("rejects unknown models, including Object prototype keys", () => {
    expect(() => assertPricedModel("claude-haiku-4-5-20251001")).toThrow();
    expect(() => assertPricedModel("toString")).toThrow();
  });
});
