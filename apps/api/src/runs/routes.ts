import {
  type ApiError,
  CreateRunRequest,
  type CreateRunResponse,
  type RunResponse,
} from "@tunelynk/shared";
import { Hono } from "hono";
import { type AuthDeps, type AuthEnv, ensureUser } from "../auth/middleware";
import type { RunJob } from "./executor";
import type { RunRepo } from "./repo";

export const GUEST_LENGTH = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunsDeps = {
  repo: RunRepo;
  executor: { start(job: RunJob): Promise<void> };
  dailyBudgetMicros: number;
  reservePerRunMicros: number;
  model: string;
};

export function runsRoutes(deps: RunsDeps, auth: AuthDeps) {
  return new Hono<AuthEnv>()
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

      const user = await ensureUser(c, auth);
      const run = await deps.repo.createRun({
        userId: user.id,
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
        kind: user.isGuest ? "guest" : "user",
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
      const run = UUID.test(id) ? await deps.repo.getRun(id) : undefined;
      if (!run) return c.json({ error: "not_found" } satisfies ApiError, 404);
      return c.json(run satisfies RunResponse, 200);
    });
}
