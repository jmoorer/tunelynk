import { z } from "zod";

// One schema for every provider. Structured outputs need every field required,
// so "no refusal" is null rather than absent. Length limits (name ≤ 60, ≤ 10
// plan artists) are not expressible in the schema and are clamped after parsing.
export const LlmOutput = z.object({
  refusal: z.string().nullable(),
  name: z.string(),
  plan: z.object({
    artists: z.array(z.string()),
    vibe: z.string(),
  }),
  candidates: z.array(z.object({ title: z.string(), artist: z.string() })),
});
export type LlmOutput = z.infer<typeof LlmOutput>;

export type TrackKey = { title: string; artist: string };

export type LlmUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type CandidateRequest = {
  prompt: string;
  count: number;
  exclude: TrackKey[];
};

export type LlmResult = { output: LlmOutput; usage: LlmUsage };

export interface LlmProvider {
  readonly model: string;
  generateCandidates(input: CandidateRequest): Promise<LlmResult>;
}

// What a provider adapter does: one structured-output request, raw text back.
export type LlmCompletion = {
  text: string | undefined;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
};

export type LlmTransport = (request: {
  system: string;
  user: string;
}) => Promise<LlmCompletion>;
