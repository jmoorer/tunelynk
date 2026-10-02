import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createLlmProviderFromTransport } from "./provider";
import { LlmOutput, type LlmProvider } from "./types";

export type ProviderOptions = {
  apiKey: string;
  model: string;
  maxTokens: number;
  fetch?: typeof fetch;
};

export const LLM_TIMEOUT_MS = 60_000;

export function createAnthropicProvider({
  apiKey,
  model,
  maxTokens,
  fetch,
}: ProviderOptions): LlmProvider {
  // The SDK retries timeouts, connection errors, 429 and 5xx; one retry per the spec.
  const client = new Anthropic({
    apiKey,
    timeout: LLM_TIMEOUT_MS,
    maxRetries: 1,
    fetch,
  });
  // create(), not parse(): parse() throws on a schema mismatch and drops usage.
  const { schema } = zodOutputFormat(LlmOutput);

  return createLlmProviderFromTransport(model, async ({ system, user }) => {
    const message = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema } },
    });
    const text = message.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text",
    );
    return {
      text: text?.text,
      stopReason: message.stop_reason,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  });
}
