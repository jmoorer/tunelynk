import { createAnthropicProvider, type ProviderOptions } from "./anthropic";
import { createOpenAIProvider } from "./openai";
import type { LlmProvider } from "./types";

export type LlmProviderName = "anthropic" | "openai";
export type LlmConfig = ProviderOptions & { provider: LlmProviderName };

export function createLlmProvider({
  provider,
  ...options
}: LlmConfig): LlmProvider {
  return provider === "anthropic"
    ? createAnthropicProvider(options)
    : createOpenAIProvider(options);
}

export { createAnthropicProvider, createOpenAIProvider, type ProviderOptions };
