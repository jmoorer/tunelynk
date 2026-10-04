import {
  costMicros,
  type GenerateResult,
  NotEnoughTracksError,
  RefusalError,
} from "@tunelynk/engine";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor, type Engine, type ExecutorRepo } from "./executor";
import { RUN_ERRORS } from "./messages";

const usage = {
  model: "claude-haiku-4-5",
  inputTokens: 100,
  outputTokens: 200,
};
const job = {
  runId: "run-1",
  kind: "guest" as const,
  prompt: "road trip",
  length: 20,
};
const result: GenerateResult = {
  name: "Road Trip",
  tracks: [],
  candidates: [],
  usage,
};

function fakeRepo(overrides: Partial<ExecutorRepo> = {}) {
  return {
    markRunning: vi.fn(async () => true),
    setStage: vi.fn(async () => {}),
    completeRun: vi.fn(async () => true),
    failRun: vi.fn(async () => true),
    recordUsage: vi.fn(async () => {}),
    ...overrides,
  } satisfies ExecutorRepo;
}

const quietLogger = () => ({ error: vi.fn() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createRunExecutor", () => {
  it("runs the engine, forwards stages, records usage, and completes", async () => {
    const repo = fakeRepo();
    const engine = vi.fn<Engine>(async (_input, onStage) => {
      onStage("llm");
      onStage("matching");
      return result;
    });

    await createRunExecutor({ repo, engine }).start(job);

    expect(repo.markRunning).toHaveBeenCalledWith("run-1");
    expect(engine.mock.calls[0]?.[0]).toEqual({
      prompt: "road trip",
      length: 20,
    });
    expect(vi.mocked(repo.setStage).mock.calls).toEqual([
      ["run-1", "llm"],
      ["run-1", "matching"],
    ]);
    expect(repo.recordUsage).toHaveBeenCalledWith({
      runId: "run-1",
      usage,
      costMicros: costMicros(usage),
      kind: "guest",
    });
    expect(repo.completeRun).toHaveBeenCalledWith("run-1", result);
    expect(repo.failRun).not.toHaveBeenCalled();
  });

  it("records usage with the job's kind", async () => {
    const repo = fakeRepo();
    await createRunExecutor({ repo, engine: async () => result }).start({
      ...job,
      kind: "user",
    });
    expect(repo.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", kind: "user" }),
    );
  });

  it("does nothing when the run is no longer queued", async () => {
    const repo = fakeRepo({ markRunning: vi.fn(async () => false) });
    const engine = vi.fn<Engine>(async () => result);
    await createRunExecutor({ repo, engine }).start(job);
    expect(engine).not.toHaveBeenCalled();
  });

  it("maps a refusal to the refusal message and records usage", async () => {
    const repo = fakeRepo();
    const engine: Engine = async () => {
      throw new RefusalError("not music", usage);
    };
    await createRunExecutor({ repo, engine, logger: quietLogger() }).start(job);
    expect(repo.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ usage }),
    );
    expect(repo.failRun).toHaveBeenCalledWith(
      "run-1",
      RUN_ERRORS.refusal,
      undefined,
    );
  });

  it("stores candidates when there are not enough tracks", async () => {
    const repo = fakeRepo();
    const candidates = [
      { title: "A", artist: "B", status: "unmatched" as const },
    ];
    const engine: Engine = async () => {
      throw new NotEnoughTracksError(1, 10, candidates, usage);
    };
    await createRunExecutor({ repo, engine, logger: quietLogger() }).start(job);
    expect(repo.failRun).toHaveBeenCalledWith(
      "run-1",
      RUN_ERRORS.notEnough,
      candidates,
    );
  });

  it("still fails the run when recording usage fails on the error path", async () => {
    const repo = fakeRepo({
      recordUsage: vi.fn(async () => Promise.reject(new Error("db blip"))),
    });
    const engine: Engine = async () => {
      throw new RefusalError("not music", usage);
    };
    await createRunExecutor({ repo, engine, logger: quietLogger() }).start(job);
    expect(repo.failRun).toHaveBeenCalledWith(
      "run-1",
      RUN_ERRORS.refusal,
      undefined,
    );
  });

  it("completes the run even when recording usage fails", async () => {
    const repo = fakeRepo({
      recordUsage: vi.fn(async () => Promise.reject(new Error("db blip"))),
    });
    const logger = quietLogger();
    await createRunExecutor({
      repo,
      engine: async () => result,
      logger,
    }).start(job);
    expect(repo.completeRun).toHaveBeenCalledWith("run-1", result);
    expect(repo.failRun).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("uses the generic message for unexpected errors and logs them", async () => {
    const repo = fakeRepo();
    const logger = quietLogger();
    const engine: Engine = async () => {
      throw new Error("socket hang up");
    };
    await createRunExecutor({ repo, engine, logger }).start(job);
    expect(repo.recordUsage).not.toHaveBeenCalled();
    expect(repo.failRun).toHaveBeenCalledWith(
      "run-1",
      RUN_ERRORS.generic,
      undefined,
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("fails the run at the deadline and still records late usage", async () => {
    const repo = fakeRepo({ completeRun: vi.fn(async () => false) });
    const engine: Engine = async () => {
      await sleep(50);
      return result;
    };

    await createRunExecutor({
      repo,
      engine,
      deadlineMs: 10,
      logger: quietLogger(),
    }).start(job);

    expect(repo.failRun).toHaveBeenCalledWith("run-1", RUN_ERRORS.timeout);
    expect(repo.completeRun).not.toHaveBeenCalled();
    await sleep(80);
    expect(repo.recordUsage).toHaveBeenCalledTimes(1);
    expect(repo.completeRun).toHaveBeenCalledTimes(1); // late, and a no-op in the real repo
  });

  it("keeps going when a stage update fails", async () => {
    const repo = fakeRepo({
      setStage: vi.fn(async () => Promise.reject(new Error("db blip"))),
    });
    const logger = quietLogger();
    const engine: Engine = async (_input, onStage) => {
      onStage("llm");
      return result;
    };
    await createRunExecutor({ repo, engine, logger }).start(job);
    await sleep(0);
    expect(repo.completeRun).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("never rejects, even when the repository is down", async () => {
    const repo = fakeRepo({
      markRunning: vi.fn(async () => Promise.reject(new Error("db down"))),
      failRun: vi.fn(async () => Promise.reject(new Error("db down"))),
    });
    const engine = vi.fn<Engine>(async () => result);
    await expect(
      createRunExecutor({ repo, engine, logger: quietLogger() }).start(job),
    ).resolves.toBeUndefined();
    expect(engine).not.toHaveBeenCalled();
  });
});
