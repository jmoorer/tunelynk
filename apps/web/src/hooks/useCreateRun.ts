import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type CreateRunResult, createRun } from "../lib/api";
import { runPath } from "../lib/format";

export const CREATE_ERRORS = {
  invalid_prompt: "Prompts need 1–280 characters.",
  budget_exceeded: "Daily generation limit reached. Try again tomorrow.",
  run_in_progress: "You already have a playlist generating.",
  not_found: "Something went wrong. Try again.",
  network: "Couldn't reach Tunelynk. Check your connection and try again.",
} as const;

export type CreateError = { message: string; href?: string };

function toError(result: Extract<CreateRunResult, { ok: false }>): CreateError {
  const message = CREATE_ERRORS[result.error];
  return result.error === "run_in_progress" && result.runId && result.playlistId
    ? { message, href: runPath(result.playlistId, result.runId) }
    : { message };
}

export function useCreateRun() {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CreateError | null>(null);
  // A ref, not state: two clicks in one tick must still send one request.
  const inFlight = useRef(false);

  const submit = useCallback(
    async (prompt: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setError(null);
      const result = await createRun(prompt);
      inFlight.current = false;
      setPending(false);
      if (result.ok) {
        navigate(runPath(result.playlistId, result.runId));
        return;
      }
      setError(toError(result));
    },
    [navigate],
  );

  return { submit, pending, error };
}
