import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { ErrorBanner } from "../components/ErrorBanner";
import { NowPlayingBar } from "../components/NowPlayingBar";
import { PlaybackNotice } from "../components/PlaybackNotice";
import { Shell } from "../components/Shell";
import { TopBar } from "../components/TopBar";
import { TrackGrid } from "../components/TrackGrid";
import { useCreateRun } from "../hooks/useCreateRun";
import { useElapsed } from "../hooks/useElapsed";
import { usePreviewPlayer } from "../hooks/usePreviewPlayer";
import { isRunning, useRun } from "../hooks/useRun";
import { formatTotalDuration, stageLabel } from "../lib/format";

export function RunView() {
  const { runId = "" } = useParams();
  const state = useRun(runId);
  const { run, notFound, reconnecting } = state;
  const running = isRunning(state);
  const elapsed = useElapsed(running);
  const player = usePreviewPlayer();
  const create = useCreateRun();

  // A new run (retry, new prompt) must not keep playing the old clip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId is the trigger
  useEffect(() => player.stop(), [runId, player.stop]);

  const busyLabel = create.pending
    ? "Starting…"
    : running
      ? `${elapsed}s`
      : undefined;
  const topBar = (
    <TopBar
      initialPrompt={run?.playlist.prompt ?? ""}
      busyLabel={busyLabel}
      onSubmit={create.submit}
    />
  );

  if (notFound) {
    return (
      <Shell>
        {topBar}
        <section className="py-24 text-center">
          <p className="text-2xl font-bold">This playlist doesn't exist.</p>
          <Link to="/" className="mt-3 inline-block text-white/60 underline">
            Start a new one
          </Link>
        </section>
      </Shell>
    );
  }

  const failed = run?.status === "failed";
  const finished = run && !running && !failed;
  const tracks = finished ? run.tracks : null;

  return (
    <Shell>
      {topBar}
      {create.error && <ErrorBanner {...create.error} />}
      <section className="mx-auto max-w-6xl px-6 pt-10">
        <div className="mb-8 flex items-end justify-between gap-6">
          <div className="min-w-0">
            {run && (
              <p className="truncate text-sm text-white/50">
                “{run.playlist.prompt}”
              </p>
            )}
            <h1 className="mt-1 text-4xl font-black">
              {failed ? (
                run.error
              ) : finished ? (
                run.playlist.name
              ) : (
                <span className="animate-pulse text-white/40">
                  {stageLabel(run?.stage ?? null)}
                </span>
              )}
            </h1>
            {finished && (
              <p className="mt-1 text-sm text-white/50">
                {run.tracks.length} tracks · {formatTotalDuration(run.tracks)}
              </p>
            )}
            {reconnecting && running && (
              <p className="mt-1 text-sm text-amber-300/80">Reconnecting…</p>
            )}
          </div>
          {finished && (
            <button
              type="button"
              disabled
              title="Accounts are coming soon"
              className="shrink-0 rounded-full border border-white/30 px-5 py-2.5 text-sm opacity-50"
            >
              Sign in to keep
            </button>
          )}
        </div>

        {failed ? (
          <button
            type="button"
            disabled={create.pending}
            onClick={() => create.submit(run.playlist.prompt)}
            className="rounded-full bg-white px-5 py-2.5 font-semibold text-zinc-950 disabled:opacity-40"
          >
            Try again
          </button>
        ) : (
          <TrackGrid tracks={tracks} player={player} />
        )}

        {finished && run.unmatched.length > 0 && (
          <p className="mt-10 text-sm text-white/40">
            Couldn't find on Apple Music:{" "}
            {run.unmatched.map((u) => `${u.title} (${u.artist})`).join(", ")}
          </p>
        )}
      </section>
      <PlaybackNotice player={player} />
      <NowPlayingBar player={player} tracks={run?.tracks ?? []} />
    </Shell>
  );
}
