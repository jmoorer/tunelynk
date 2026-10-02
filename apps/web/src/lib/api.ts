import { ApiError, CreateRunResponse, RunResponse } from "@tunelynk/shared";

// Same-origin: the API serves the SPA in production and Vite proxies /api in dev,
// so the guest cookie travels with every request.

export type CreateRunResult =
  | { ok: true; runId: string; playlistId: string }
  | {
      ok: false;
      error: ApiError["error"] | "network";
      runId?: string;
      playlistId?: string;
    };

export async function createRun(prompt: string): Promise<CreateRunResult> {
  let res: Response;
  try {
    res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 202) {
    const created = CreateRunResponse.safeParse(body);
    return created.success
      ? { ok: true, ...created.data }
      : { ok: false, error: "network" };
  }
  const error = ApiError.safeParse(body);
  return error.success
    ? { ok: false, ...error.data }
    : { ok: false, error: "network" };
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

export async function fetchRun(runId: string): Promise<RunResponse> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) throw new RunNotFoundError(runId);
  if (!res.ok)
    throw new Error(`GET /api/runs/${runId} failed with ${res.status}`);
  return RunResponse.parse(await res.json());
}
