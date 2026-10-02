import type { RunResponse, RunStatus } from "@tunelynk/shared";
import { useEffect, useState } from "react";
import { fetchRun, RunNotFoundError } from "../lib/api";

export const POLL_MS = 1000;
const TERMINAL: RunStatus[] = ["draft", "published", "failed", "expired"];

export type RunState = {
  run: RunResponse | null;
  notFound: boolean;
  reconnecting: boolean;
};

const initial: RunState = { run: null, notFound: false, reconnecting: false };

export function isRunning({ run, notFound }: RunState): boolean {
  if (notFound) return false;
  return !run || run.status === "queued" || run.status === "running";
}

// Polls until the run finishes. Network errors keep polling (a deploy or a
// blip shouldn't strand the page); a 404 stops.
export function useRun(runId: string): RunState {
  const [state, setState] = useState<RunState>(initial);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(initial);

    const poll = async () => {
      try {
        const run = await fetchRun(runId);
        if (cancelled) return;
        setState({ run, notFound: false, reconnecting: false });
        if (TERMINAL.includes(run.status)) return;
      } catch (err) {
        if (cancelled) return;
        if (err instanceof RunNotFoundError) {
          setState({ run: null, notFound: true, reconnecting: false });
          return;
        }
        setState((s) => ({ ...s, reconnecting: true }));
      }
      timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId]);

  return state;
}
