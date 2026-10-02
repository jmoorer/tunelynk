import { describe, expect, it } from "vitest";
import { createOpenAIProvider } from "./openai";
import { SYSTEM_PROMPT } from "./prompt";
import type { LlmOutput } from "./types";

const valid: LlmOutput = {
  refusal: null,
  name: "Road Trip",
  plan: { artists: ["Fleetwood Mac"], vibe: "sunny" },
  candidates: [{ title: "Dreams", artist: "Fleetwood Mac" }],
};

const responseReply = (
  text: string,
  extra: Record<string, unknown> = { status: "completed" },
) =>
  new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt-4.1-mini",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: { input_tokens: 90, output_tokens: 60, total_tokens: 150 },
      ...extra,
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

describe("createOpenAIProvider", () => {
  it("sends a structured-output Responses request and parses the reply", async () => {
    const { fetch, requests } = recordingFetch([
      () => responseReply(JSON.stringify(valid)),
    ]);
    const llm = createOpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4.1-mini",
      maxTokens: 2000,
      fetch,
    });

    const result = await llm.generateCandidates(request);

    expect(result).toEqual({
      output: valid,
      usage: { model: "gpt-4.1-mini", inputTokens: 90, outputTokens: 60 },
    });
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.body).toMatchObject({
      model: "gpt-4.1-mini",
      instructions: SYSTEM_PROMPT,
      input: "<request>road trip</request>\n\nPropose 32 songs.",
      max_output_tokens: 2000,
      text: { format: { type: "json_schema", name: "playlist", strict: true } },
    });
  });

  it("maps a max_output_tokens cut-off to the repair message", async () => {
    const { fetch, requests } = recordingFetch([
      () =>
        responseReply('{"refusal": null, "na', {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      () => responseReply(JSON.stringify(valid)),
    ]);
    const llm = createOpenAIProvider({
      apiKey: "test-key",
      model: "gpt-4.1-mini",
      maxTokens: 2000,
      fetch,
    });

    await llm.generateCandidates(request);

    expect(requests[1]?.body.input).toContain(
      "output was cut off at max_tokens",
    );
  });
});
