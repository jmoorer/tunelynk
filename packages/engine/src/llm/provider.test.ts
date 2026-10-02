import { describe, expect, it, vi } from "vitest";
import { LlmError } from "../errors";
import { SYSTEM_PROMPT } from "./prompt";
import { createLlmProviderFromTransport } from "./provider";
import type { LlmCompletion, LlmOutput } from "./types";

const valid: LlmOutput = {
  refusal: null,
  name: "Road Trip",
  plan: { artists: ["Fleetwood Mac"], vibe: "sunny" },
  candidates: [{ title: "Dreams", artist: "Fleetwood Mac" }],
};

const reply = (
  text: string | undefined,
  stopReason: string | null = "end_turn",
): LlmCompletion => ({ text, stopReason, inputTokens: 100, outputTokens: 50 });

const request = { prompt: "road trip", count: 32, exclude: [] };

describe("createLlmProviderFromTransport", () => {
  it("returns validated output and usage on the first try", async () => {
    const transport = vi.fn(async () => reply(JSON.stringify(valid)));
    const llm = createLlmProviderFromTransport("claude-haiku-4-5", transport);

    const result = await llm.generateCandidates(request);

    expect(llm.model).toBe("claude-haiku-4-5");
    expect(result).toEqual({
      output: valid,
      usage: { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 50 },
    });
    expect(transport).toHaveBeenCalledWith({
      system: SYSTEM_PROMPT,
      user: "<request>road trip</request>\n\nPropose 32 songs.",
    });
  });

  it("clamps the name to 60 characters and plan artists to 10", async () => {
    const long = {
      ...valid,
      name: `  ${"x".repeat(80)}  `,
      plan: {
        artists: Array.from({ length: 12 }, (_, i) => `A${i}`),
        vibe: "v",
      },
    };
    const llm = createLlmProviderFromTransport("claude-haiku-4-5", async () =>
      reply(JSON.stringify(long)),
    );
    const { output } = await llm.generateCandidates(request);
    expect(output.name).toBe("x".repeat(60));
    expect(output.plan.artists).toHaveLength(10);
  });

  it("retries once with a repair message and sums usage", async () => {
    const transport = vi
      .fn<(r: { system: string; user: string }) => Promise<LlmCompletion>>()
      .mockResolvedValueOnce(reply("{not json"))
      .mockResolvedValueOnce(reply(JSON.stringify(valid)));
    const llm = createLlmProviderFromTransport("claude-haiku-4-5", transport);

    const result = await llm.generateCandidates(request);

    expect(result.output).toEqual(valid);
    expect(result.usage).toEqual({
      model: "claude-haiku-4-5",
      inputTokens: 200,
      outputTokens: 100,
    });
    const second = transport.mock.calls[1]?.[0].user ?? "";
    expect(second).toContain("<request>road trip</request>");
    expect(second).toContain("did not match the required JSON schema");
    expect(second).toContain("response was not valid JSON");
  });

  it("names the failing field in the repair message", async () => {
    const transport = vi
      .fn<(r: { system: string; user: string }) => Promise<LlmCompletion>>()
      .mockResolvedValueOnce(reply(JSON.stringify({ ...valid, name: 7 })))
      .mockResolvedValueOnce(reply(JSON.stringify(valid)));
    const llm = createLlmProviderFromTransport("claude-haiku-4-5", transport);
    await llm.generateCandidates(request);
    expect(transport.mock.calls[1]?.[0].user).toMatch(/name: .*string/i);
  });

  it("says the output was cut off when the model hit max_tokens", async () => {
    const transport = vi
      .fn<(r: { system: string; user: string }) => Promise<LlmCompletion>>()
      .mockResolvedValueOnce(
        reply('{"refusal": null, "name": "Ro', "max_tokens"),
      )
      .mockResolvedValueOnce(reply(JSON.stringify(valid)));
    const llm = createLlmProviderFromTransport("claude-haiku-4-5", transport);
    await llm.generateCandidates(request);
    expect(transport.mock.calls[1]?.[0].user).toContain(
      "output was cut off at max_tokens",
    );
  });

  it("throws LlmError with summed usage after two invalid responses", async () => {
    const llm = createLlmProviderFromTransport("claude-haiku-4-5", async () =>
      reply(undefined),
    );
    const err = await llm.generateCandidates(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({
      message: "LLM returned invalid output twice: empty response",
      usage: { model: "claude-haiku-4-5", inputTokens: 200, outputTokens: 100 },
    });
  });

  it("wraps transport failures in LlmError with the cause", async () => {
    const cause = new Error("connect ECONNREFUSED");
    const llm = createLlmProviderFromTransport("claude-haiku-4-5", async () => {
      throw cause;
    });
    const err = await llm.generateCandidates(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({
      message: "LLM request failed: connect ECONNREFUSED",
      cause,
    });
  });

  it("refuses to build a provider for an unpriced model", () => {
    expect(() =>
      createLlmProviderFromTransport("mystery", async () => reply("{}")),
    ).toThrow(/No price/);
  });
});
