import {
  type ApiError,
  CreateRunRequest,
  type CreateRunResponse,
  type RunResponse,
} from "@tunelynk/shared";
import { type Context, Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import type { RunJob } from "./executor";
import type { RunRepo } from "./repo";

export const GUEST_COOKIE = "tl_guest";
export const GUEST_LENGTH = 20;
const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunsDeps = {
  repo: RunRepo;
  executor: { start(job: RunJob): Promise<void> };
  sessionSecret: string;
  secureCookies: boolean;
  dailyBudgetMicros: number;
  reservePerRunMicros: number;
  model: string;
};

async function readGuest(
  c: Context,
  deps: RunsDeps,
): Promise<string | undefined> {
  const value = await getSignedCookie(c, deps.sessionSecret, GUEST_COOKIE);
  if (!value || !UUID.test(value)) return undefined;
  return (await deps.repo.findUser(value)) ? value : undefined;
}

async function ensureGuest(c: Context, deps: RunsDeps): Promise<string> {
  const existing = await readGuest(c, deps);
  if (existing) {
    await deps.repo.touchUser(existing);
    return existing;
  }
  const id = await deps.repo.createGuest();
  await setSignedCookie(c, GUEST_COOKIE, id, deps.sessionSecret, {
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.secureCookies,
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE,
  });
  return id;
}

export function runsRoutes(deps: RunsDeps) {
  return new Hono()
    .post("/", async (c) => {
      const body = CreateRunRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!body.success) {
        return c.json({ error: "invalid_prompt" } satisfies ApiError, 400);
      }
      const prompt = body.data.prompt;

      const committed = await deps.repo.committedCostMicros(
        deps.reservePerRunMicros,
      );
      if (committed >= deps.dailyBudgetMicros) {
        return c.json({ error: "budget_exceeded" } satisfies ApiError, 503);
      }

      const userId = await ensureGuest(c, deps);
      const run = await deps.repo.createRun({
        userId,
        prompt,
        length: GUEST_LENGTH,
        model: deps.model,
      });
      if (!run.created) {
        return c.json(
          {
            error: "run_in_progress",
            runId: run.runId,
            playlistId: run.playlistId,
          } satisfies ApiError,
          409,
        );
      }

      // Fire and forget: the client polls GET /api/runs/:id.
      void deps.executor.start({
        runId: run.runId,
        userId,
        prompt,
        length: GUEST_LENGTH,
      });
      return c.json(
        {
          runId: run.runId,
          playlistId: run.playlistId,
        } satisfies CreateRunResponse,
        202,
      );
    })
    .get("/:id", async (c) => {
      const id = c.req.param("id");
      const guest = await readGuest(c, deps);
      if (guest) await deps.repo.touchUser(guest);
      const run = UUID.test(id) ? await deps.repo.getRun(id) : undefined;
      if (!run) return c.json({ error: "not_found" } satisfies ApiError, 404);
      return c.json(run satisfies RunResponse, 200);
    });
}
