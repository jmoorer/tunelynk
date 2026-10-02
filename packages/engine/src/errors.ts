import type { LlmUsage } from "./llm/types";
import type { CandidateResult } from "./types";

// Every engine failure after the LLM call carries usage so callers can still
// record what the run cost.
export class EngineError extends Error {
  readonly usage: LlmUsage | undefined;

  constructor(message: string, usage?: LlmUsage, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.usage = usage;
  }
}

export class LlmError extends EngineError {}

export class RefusalError extends EngineError {
  readonly reason: string;

  constructor(reason: string, usage: LlmUsage) {
    super(`LLM declined the request: ${reason}`, usage);
    this.reason = reason;
  }
}

export class NotEnoughTracksError extends EngineError {
  readonly found: number;
  readonly needed: number;
  readonly candidates: CandidateResult[];

  constructor(
    found: number,
    needed: number,
    candidates: CandidateResult[],
    usage: LlmUsage,
  ) {
    super(`Found ${found} tracks; need at least ${needed}`, usage);
    this.found = found;
    this.needed = needed;
    this.candidates = candidates;
  }
}
