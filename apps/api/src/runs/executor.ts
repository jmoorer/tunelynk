import {
  costMicros,
  EngineError,
  type GenerateInput,
  type GenerateResult,
  type LlmUsage,
  NotEnoughTracksError,
  RefusalError,
  type Stage,
} from "@tunelynk/engine";
import { RUN_ERRORS } from "./messages";
import type { RunRepo } from "./repo";

export type Engine = (
  input: GenerateInput,
  onStage: (stage: Stage) => void,
) => Promise<GenerateResult>;

export type RunJob = {
  runId: string;
  userId: string;
  prompt: string;
  length: number;
};

export type ExecutorRepo = Pick<
  RunRepo,
  "markRunning" | "setStage" | "completeRun" | "failRun" | "recordUsage"
>;

// Bounds a whole run. SDK timeouts and the schema-repair retry can otherwise
// stack up to about 4 minutes.
export const RUN_DEADLINE_MS = 120_000;

function messageFor(err: unknown): string {
  if (err instanceof RefusalError) return RUN_ERRORS.refusal;
  if (err instanceof NotEnoughTracksError) return RUN_ERRORS.notEnough;
  return RUN_ERRORS.generic;
}

export function createRunExecutor({
  repo,
  engine,
  deadlineMs = RUN_DEADLINE_MS,
  logger = console,
}: {
  repo: ExecutorRepo;
  engine: Engine;
  deadlineMs?: number;
  logger?: Pick<Console, "error">;
}) {
  const recordUsage = (userId: string, usage: LlmUsage) =>
    repo.recordUsage({
      userId,
      usage,
      costMicros: costMicros(usage),
      kind: "guest",
    });

  async function execute(job: RunJob): Promise<void> {
    try {
      const result = await engine(
        { prompt: job.prompt, length: job.length },
        (stage) => {
          repo
            .setStage(job.runId, stage)
            .catch((err) =>
              logger.error(`run ${job.runId}: stage update failed`, err),
            );
        },
      );
      await recordUsage(job.userId, result.usage);
      await repo.completeRun(job.runId, result);
    } catch (err) {
      logger.error(`run ${job.runId} failed`, err);
      if (err instanceof EngineError && err.usage) {
        // A failed usage write must not leave the run stuck in "running".
        await recordUsage(job.userId, err.usage).catch((usageErr) =>
          logger.error(`run ${job.runId}: usage write failed`, usageErr),
        );
      }
      await repo.failRun(
        job.runId,
        messageFor(err),
        err instanceof NotEnoughTracksError ? err.candidates : undefined,
      );
    }
  }

  return {
    async start(job: RunJob): Promise<void> {
      try {
        if (!(await repo.markRunning(job.runId))) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), deadlineMs);
        });
        // After the deadline the work keeps going: it still records usage, and
        // the repo refuses to complete a run that is no longer running.
        const work = execute(job).catch((err) =>
          logger.error(`run ${job.runId}: executor error`, err),
        );
        const outcome = await Promise.race([
          work.then(() => "done" as const),
          deadline,
        ]);
        clearTimeout(timer);
        if (outcome === "deadline") {
          await repo.failRun(job.runId, RUN_ERRORS.timeout);
        }
      } catch (err) {
        logger.error(`run ${job.runId}: executor error`, err);
        await repo.failRun(job.runId, RUN_ERRORS.generic).catch(() => {});
      }
    },
  };
}
