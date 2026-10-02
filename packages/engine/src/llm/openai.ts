import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { LLM_TIMEOUT_MS, type ProviderOptions } from "./anthropic";
import { createLlmProviderFromTransport } from "./provider";
import { LlmOutput, type LlmProvider } from "./types";

export function createOpenAIProvider({
  apiKey,
  model,
  maxTokens,
  fetch,
}: ProviderOptions): LlmProvider {
  const client = new OpenAI({
    apiKey,
    timeout: LLM_TIMEOUT_MS,
    maxRetries: 1,
    fetch,
  });
  const format = zodTextFormat(LlmOutput, "playlist");

  return createLlmProviderFromTransport(model, async ({ system, user }) => {
    const response = await client.responses.create({
      model,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
      text: { format },
    });
    const cutOff = response.incomplete_details?.reason === "max_output_tokens";
    return {
      text: response.output_text || undefined,
      stopReason: cutOff ? "max_tokens" : (response.status ?? null),
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  });
}
