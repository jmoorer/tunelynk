import { describe, expect, it } from "vitest";
import { LlmError } from "../errors";
import { createAnthropicProvider } from "./anthropic";
import { SYSTEM_PROMPT } from "./prompt";
import type { LlmOutput } from "./types";

const valid: LlmOutput = {
  refusal: null,
  name: "Road Trip",
  plan: { artists: ["Fleetwood Mac"], vibe: "sunny" },
  candidates: [{ title: "Dreams", artist: "Fleetwood Mac" }],
};

const messageReply = (text: string, stopReason = "end_turn") =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 80 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function recordingFetch(replies: Array<() => Response>) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });
    const next = replies.shift();
    if (!next) throw new Error("unexpected extra request");
    return next();
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const request = { prompt: "road trip", count: 32, exclude: [] };

describe("createAnthropicProvider", () => {
  it("sends a structured-output Messages request and parses the reply", async () => {
    const { fetch, requests } = recordingFetch([
      () => messageReply(JSON.stringify(valid)),
    ]);
    const llm = createAnthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-4-5",
      maxTokens: 2000,
      fetch,
    });

    const result = await llm.generateCandidates(request);

    expect(result).toEqual({
      output: valid,
      usage: { model: "claude-haiku-4-5", inputTokens: 120, outputTokens: 80 },
    });
    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const body = requests[0]?.body ?? {};
    expect(body).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: "<request>road trip</request>\n\nPropose 32 songs.",
        },
      ],
      output_config: { format: { type: "json_schema" } },
    });
    const schema = (body.output_config as { format: { schema: unknown } })
      .format.schema as { required: string[]; additionalProperties: boolean };
    expect(schema.required).toEqual(["refusal", "name", "plan", "candidates"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("repairs once after a schema mismatch, summing usage", async () => {
    const { fetch, requests } = recordingFetch([
      () => messageReply('{"name": 1}'),
      () => messageReply(JSON.stringify(valid)),
    ]);
    const llm = createAnthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-4-5",
      maxTokens: 2000,
      fetch,
    });

    const result = await llm.generateCandidates(request);

    expect(result.usage).toMatchObject({ inputTokens: 240, outputTokens: 160 });
    const messages = requests[1]?.body.messages as Array<{ content: string }>;
    expect(messages[0]?.content).toContain(
      "did not match the required JSON schema",
    );
  });

  it("lets the SDK retry a 500 once, then gives up with LlmError", async () => {
    const serverError = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "boom" },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    const { fetch, requests } = recordingFetch([serverError, serverError]);
    const llm = createAnthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-4-5",
      maxTokens: 2000,
      fetch,
    });

    const err = await llm.generateCandidates(request).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmError);
    expect(requests).toHaveLength(2);
  });
});
