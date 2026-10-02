import { describe, expect, it } from "vitest";
import {
  EngineError,
  LlmError,
  NotEnoughTracksError,
  RefusalError,
} from "./errors";

const usage = { model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 20 };

describe("engine errors", () => {
  it("carry usage and their own name", () => {
    const err = new LlmError("boom", usage);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LlmError");
    expect(err.usage).toEqual(usage);
  });

  it("RefusalError keeps the reason", () => {
    const err = new RefusalError("not a music request", usage);
    expect(err.reason).toBe("not a music request");
    expect(err.message).toContain("not a music request");
    expect(err.usage).toEqual(usage);
  });

  it("NotEnoughTracksError keeps counts and candidates", () => {
    const candidates = [
      { title: "A", artist: "B", status: "unmatched" as const },
    ];
    const err = new NotEnoughTracksError(3, 10, candidates, usage);
    expect(err).toMatchObject({ found: 3, needed: 10, candidates, usage });
    expect(err.message).toBe("Found 3 tracks; need at least 10");
  });

  it("passes cause through", () => {
    const cause = new Error("root");
    expect(new LlmError("wrapped", undefined, { cause }).cause).toBe(cause);
  });
});
