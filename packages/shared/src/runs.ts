import { z } from "zod";

export const PROMPT_MAX_LENGTH = 280;

export const CreateRunRequest = z.object({
  prompt: z.string().trim().min(1).max(PROMPT_MAX_LENGTH),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CreateRunResponse = z.object({
  runId: z.uuid(),
  playlistId: z.uuid(),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const RunStatus = z.enum([
  "queued",
  "running",
  "draft",
  "published",
  "failed",
  "expired",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunStage = z.enum(["taste", "llm", "matching"]);
export type RunStage = z.infer<typeof RunStage>;

export const RunTrack = z.object({
  position: z.number().int(),
  appleSongId: z.string(),
  title: z.string(),
  artistName: z.string(),
  album: z.string(),
  artworkUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  durationMs: z.number().int(),
  explicit: z.boolean(),
  source: z.enum(["llm", "backfill"]),
});
export type RunTrack = z.infer<typeof RunTrack>;

export const RunResponse = z.object({
  id: z.uuid(),
  status: RunStatus,
  stage: RunStage.nullable(),
  error: z.string().nullable(),
  playlist: z.object({ id: z.uuid(), name: z.string(), prompt: z.string() }),
  tracks: z.array(RunTrack),
  unmatched: z.array(z.object({ title: z.string(), artist: z.string() })),
});
export type RunResponse = z.infer<typeof RunResponse>;

export const ApiError = z.object({
  error: z.enum([
    "invalid_prompt",
    "budget_exceeded",
    "run_in_progress",
    "not_found",
    "json_required",
    "session_expired",
    "invalid_email",
    "too_many_requests",
    "email_failed",
    "invalid_or_expired",
  ]),
  runId: z.uuid().optional(),
  playlistId: z.uuid().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
