import type { PlaybackIssue, PreviewPlayer } from "../hooks/usePreviewPlayer";

export const PLAYBACK_MESSAGES: Record<PlaybackIssue, string> = {
  unavailable:
    "Couldn't play that preview. A browser extension or privacy setting may be blocking audio from Apple.",
  "autoplay-blocked":
    "Your browser blocked playback. Tap the track again to play.",
};

export function PlaybackNotice({ player }: { player: PreviewPlayer }) {
  if (!player.issue) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-24 z-30 mx-auto flex max-w-3xl items-center gap-4 rounded-2xl border border-amber-300/30 bg-zinc-900/95 px-4 py-3 text-sm text-amber-100 shadow-2xl backdrop-blur"
    >
      <span className="flex-1">{PLAYBACK_MESSAGES[player.issue]}</span>
      <button
        type="button"
        onClick={player.dismissIssue}
        className="shrink-0 font-semibold text-white/80 hover:text-white"
      >
        Dismiss
      </button>
    </div>
  );
}
