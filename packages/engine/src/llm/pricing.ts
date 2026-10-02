import type { LlmUsage } from "./types";

// USD per 1M tokens, which is also micro-dollars per token.
// Sources: Anthropic model table and developers.openai.com/api/docs/pricing (2026-10-01).
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-5-mini": { input: 0.25, output: 2 },
};

function priceOf(model: string) {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!price) {
    throw new Error(
      `No price for LLM model "${model}". Add it to packages/engine/src/llm/pricing.ts so usage cost is tracked.`,
    );
  }
  return price;
}

export function assertPricedModel(model: string): void {
  priceOf(model);
}

export function costMicros({
  model,
  inputTokens,
  outputTokens,
}: LlmUsage): number {
  const price = priceOf(model);
  return Math.round(inputTokens * price.input + outputTokens * price.output);
}
