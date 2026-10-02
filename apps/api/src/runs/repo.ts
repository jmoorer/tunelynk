import {
  type Db,
  generationRuns,
  llmUsage,
  playlists,
  type RunCandidate,
  runTracks,
  tracks,
  users,
} from "@tunelynk/db";
import type { GeneratedTrack, LlmUsage, Stage } from "@tunelynk/engine";
import type { RunResponse } from "@tunelynk/shared";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { RUN_ERRORS } from "./messages";

const ACTIVE: ("queued" | "running")[] = ["queued", "running"];
const NAME_FROM_PROMPT_LENGTH = 60;

export type CompletedRun = {
  name: string;
  tracks: GeneratedTrack[];
  candidates: RunCandidate[];
};

export function createRunRepo(db: Db) {
  return {
    async createGuest(): Promise<string> {
      const [row] = await db
        .insert(users)
        .values({ isGuest: true })
        .returning({ id: users.id });
      if (!row) throw new Error("guest insert returned no row");
      return row.id;
    },

    async findUser(id: string): Promise<{ id: string } | undefined> {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, id));
      return row;
    },

    async touchUser(id: string): Promise<void> {
      await db
        .update(users)
        .set({ lastSeenAt: sql`now()` })
        .where(
          and(
            eq(users.id, id),
            lt(users.lastSeenAt, sql`now() - interval '1 minute'`),
          ),
        );
    },

    async todaysCostMicros(): Promise<number> {
      const [row] = await db
        .select({
          total: sql<string>`coalesce(sum(${llmUsage.costMicros}), 0)`,
        })
        .from(llmUsage)
        .where(
          gte(
            llmUsage.createdAt,
            sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`,
          ),
        );
      return Number(row?.total ?? 0);
    },

    // One active run per user. The advisory lock serializes concurrent POSTs
    // for the same user so both can't pass the check.
    async createRun(args: {
      userId: string;
      prompt: string;
      length: number;
      model: string;
    }): Promise<{ created: boolean; runId: string; playlistId: string }> {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${args.userId}))`,
        );
        const [active] = await tx
          .select({
            runId: generationRuns.id,
            playlistId: generationRuns.playlistId,
          })
          .from(generationRuns)
          .innerJoin(playlists, eq(playlists.id, generationRuns.playlistId))
          .where(
            and(
              eq(playlists.userId, args.userId),
              inArray(generationRuns.status, ACTIVE),
            ),
          )
          .limit(1);
        if (active) return { created: false, ...active };

        const [playlist] = await tx
          .insert(playlists)
          .values({
            userId: args.userId,
            name: args.prompt.slice(0, NAME_FROM_PROMPT_LENGTH),
            prompt: args.prompt,
            length: args.length,
          })
          .returning({ id: playlists.id });
        if (!playlist) throw new Error("playlist insert returned no row");
        const [run] = await tx
          .insert(generationRuns)
          .values({ playlistId: playlist.id, llmModel: args.model })
          .returning({ id: generationRuns.id });
        if (!run) throw new Error("run insert returned no row");
        return { created: true, runId: run.id, playlistId: playlist.id };
      });
    },

    async markRunning(runId: string): Promise<boolean> {
      const rows = await db
        .update(generationRuns)
        .set({ status: "running", startedAt: sql`now()` })
        .where(
          and(
            eq(generationRuns.id, runId),
            eq(generationRuns.status, "queued"),
          ),
        )
        .returning({ id: generationRuns.id });
      return rows.length > 0;
    },

    async setStage(runId: string, stage: Stage): Promise<void> {
      await db
        .update(generationRuns)
        .set({ stage })
        .where(
          and(
            eq(generationRuns.id, runId),
            eq(generationRuns.status, "running"),
          ),
        );
    },

    // Only a running run can complete: a run the deadline already failed
    // stays failed even if the engine finishes late.
    async completeRun(runId: string, result: CompletedRun): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [run] = await tx
          .update(generationRuns)
          .set({
            status: "draft",
            stage: null,
            candidates: result.candidates,
            finishedAt: sql`now()`,
          })
          .where(
            and(
              eq(generationRuns.id, runId),
              eq(generationRuns.status, "running"),
            ),
          )
          .returning({ playlistId: generationRuns.playlistId });
        if (!run) return false;

        if (result.tracks.length > 0) {
          const saved = await tx
            .insert(tracks)
            .values(
              result.tracks.map((t) => ({
                appleSongId: t.appleSongId,
                isrc: t.isrc ?? null,
                title: t.title,
                artistName: t.artistName,
                album: t.album,
                durationMs: t.durationMs,
                explicit: t.explicit,
                artworkUrl: t.artworkUrl ?? null,
                previewUrl: t.previewUrl ?? null,
              })),
            )
            .onConflictDoUpdate({
              target: tracks.appleSongId,
              set: {
                isrc: sql`excluded.isrc`,
                title: sql`excluded.title`,
                artistName: sql`excluded.artist_name`,
                album: sql`excluded.album`,
                durationMs: sql`excluded.duration_ms`,
                explicit: sql`excluded.explicit`,
                artworkUrl: sql`excluded.artwork_url`,
                previewUrl: sql`excluded.preview_url`,
              },
            })
            .returning({ id: tracks.id, appleSongId: tracks.appleSongId });
          const idBySong = new Map(saved.map((r) => [r.appleSongId, r.id]));
          await tx.insert(runTracks).values(
            result.tracks.map((t, i) => ({
              runId,
              position: i + 1,
              trackId: idBySong.get(t.appleSongId) as string,
              source: t.source,
            })),
          );
        }

        await tx
          .update(playlists)
          .set({ name: result.name, currentRunId: runId })
          .where(eq(playlists.id, run.playlistId));
        return true;
      });
    },

    async failRun(
      runId: string,
      error: string,
      candidates?: RunCandidate[],
    ): Promise<boolean> {
      const rows = await db
        .update(generationRuns)
        .set({
          status: "failed",
          error,
          finishedAt: sql`now()`,
          ...(candidates ? { candidates } : {}),
        })
        .where(
          and(
            eq(generationRuns.id, runId),
            inArray(generationRuns.status, ACTIVE),
          ),
        )
        .returning({ id: generationRuns.id });
      return rows.length > 0;
    },

    async recordUsage(args: {
      userId: string | null;
      usage: LlmUsage;
      costMicros: number;
      kind: "guest" | "user" | "scheduled";
    }): Promise<void> {
      await db.insert(llmUsage).values({
        userId: args.userId,
        model: args.usage.model,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        costMicros: args.costMicros,
        kind: args.kind,
      });
    },

    async getRun(runId: string): Promise<RunResponse | undefined> {
      const [row] = await db
        .select({
          id: generationRuns.id,
          status: generationRuns.status,
          stage: generationRuns.stage,
          error: generationRuns.error,
          candidates: generationRuns.candidates,
          playlistId: playlists.id,
          name: playlists.name,
          prompt: playlists.prompt,
        })
        .from(generationRuns)
        .innerJoin(playlists, eq(playlists.id, generationRuns.playlistId))
        .where(eq(generationRuns.id, runId));
      if (!row) return undefined;

      const trackRows = await db
        .select({
          position: runTracks.position,
          appleSongId: tracks.appleSongId,
          title: tracks.title,
          artistName: tracks.artistName,
          album: tracks.album,
          artworkUrl: tracks.artworkUrl,
          previewUrl: tracks.previewUrl,
          durationMs: tracks.durationMs,
          explicit: tracks.explicit,
          source: runTracks.source,
        })
        .from(runTracks)
        .innerJoin(tracks, eq(tracks.id, runTracks.trackId))
        .where(and(eq(runTracks.runId, runId), eq(runTracks.removed, false)))
        .orderBy(asc(runTracks.position));

      return {
        id: row.id,
        status: row.status,
        stage: row.stage,
        error: row.error,
        playlist: { id: row.playlistId, name: row.name, prompt: row.prompt },
        tracks: trackRows,
        unmatched: row.candidates
          .filter((c) => c.status === "unmatched")
          .map(({ title, artist }) => ({ title, artist })),
      };
    },

    async failStaleRuns(olderThanMs: number): Promise<number> {
      const rows = await db
        .update(generationRuns)
        .set({
          status: "failed",
          error: RUN_ERRORS.interrupted,
          finishedAt: sql`now()`,
        })
        .where(
          and(
            inArray(generationRuns.status, ACTIVE),
            lt(
              generationRuns.createdAt,
              sql`now() - make_interval(secs => ${olderThanMs / 1000})`,
            ),
          ),
        )
        .returning({ id: generationRuns.id });
      return rows.length;
    },
  };
}

export type RunRepo = ReturnType<typeof createRunRepo>;
