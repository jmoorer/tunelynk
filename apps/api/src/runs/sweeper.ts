import type { RunRepo } from "./repo";

// Runs execute in-process and are bounded by the executor deadline, so any
// queued/running run older than that is orphaned: a restart, a crash, or a
// DB error on the failure path. Sweep at boot and then periodically so those
// guests aren't stuck behind 409 run_in_progress.
export function startStaleRunSweeper({
  repo,
  olderThanMs,
  intervalMs,
  logger = console,
}: {
  repo: Pick<RunRepo, "failStaleRuns">;
  olderThanMs: number;
  intervalMs: number;
  logger?: Pick<Console, "log" | "error">;
}): () => void {
  const sweep = async () => {
    try {
      const failed = await repo.failStaleRuns(olderThanMs);
      if (failed > 0) logger.log(`Marked ${failed} stale run(s) as failed`);
    } catch (err) {
      logger.error("Stale run sweep failed:", err);
    }
  };
  void sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
