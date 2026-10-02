import { LlmError } from "../errors";
import { assertPricedModel } from "./pricing";
import { buildUserMessage, repairMessage, SYSTEM_PROMPT } from "./prompt";
import {
  LlmOutput,
  type LlmProvider,
  type LlmTransport,
  type LlmUsage,
} from "./types";

const MAX_ATTEMPTS = 2;
const MAX_NAME_LENGTH = 60;
const MAX_PLAN_ARTISTS = 10;

type Validation =
  | { ok: true; output: LlmOutput }
  | { ok: false; error: string };

function validate(text: string | undefined): Validation {
  if (!text) return { ok: false, error: "empty response" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "response was not valid JSON" };
  }
  const parsed = LlmOutput.safeParse(json);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error };
  }
  return { ok: true, output: parsed.data };
}

function clamp(output: LlmOutput): LlmOutput {
  return {
    ...output,
    name: output.name.trim().slice(0, MAX_NAME_LENGTH),
    plan: {
      ...output.plan,
      artists: output.plan.artists.slice(0, MAX_PLAN_ARTISTS),
    },
  };
}

// Provider-neutral core: adapters only send the request. Validation, the
// one schema-repair retry, and usage accounting live here so every provider
// behaves the same. Timeouts and network errors are retried by the SDKs.
export function createLlmProviderFromTransport(
  model: string,
  transport: LlmTransport,
): LlmProvider {
  assertPricedModel(model);

  return {
    model,
    async generateCandidates(input) {
      const user = buildUserMessage(input);
      const usage: LlmUsage = { model, inputTokens: 0, outputTokens: 0 };
      let lastError = "";

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let completion: Awaited<ReturnType<LlmTransport>>;
        try {
          completion = await transport({
            system: SYSTEM_PROMPT,
            user: attempt === 0 ? user : repairMessage(user, lastError),
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new LlmError(
            `LLM request failed: ${reason}`,
            { ...usage },
            {
              cause: err,
            },
          );
        }

        usage.inputTokens += completion.inputTokens;
        usage.outputTokens += completion.outputTokens;

        const result = validate(completion.text);
        if (result.ok) return { output: clamp(result.output), usage };
        lastError =
          completion.stopReason === "max_tokens"
            ? `${result.error}; output was cut off at max_tokens`
            : result.error;
      }

      throw new LlmError(
        `LLM returned invalid output twice: ${lastError}`,
        usage,
      );
    },
  };
}
