import { PROMPT_MAX_LENGTH } from "@tunelynk/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router";

export function TopBar({
  initialPrompt = "",
  busyLabel,
  onSubmit,
}: {
  initialPrompt?: string;
  busyLabel?: string;
  onSubmit: (prompt: string) => void;
}) {
  const [text, setText] = useState(initialPrompt);
  useEffect(() => setText(initialPrompt), [initialPrompt]);
  const blocked = !text.trim() || busyLabel !== undefined;

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-zinc-950/80 backdrop-blur">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) onSubmit(text.trim());
        }}
        className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3"
      >
        <Link
          to="/"
          className="bg-gradient-to-r from-fuchsia-400 to-amber-300 bg-clip-text font-black text-transparent"
        >
          tunelynk
        </Link>
        <input
          aria-label="Describe a playlist"
          value={text}
          maxLength={PROMPT_MAX_LENGTH}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's the vibe?"
          className="min-w-0 flex-1 rounded-full bg-white/10 px-5 py-2.5 outline-none placeholder:text-white/40 focus:bg-white/15"
        />
        <button
          type="submit"
          disabled={blocked}
          className="shrink-0 rounded-full bg-white px-5 py-2.5 font-semibold text-zinc-950 tabular-nums disabled:opacity-40"
        >
          {busyLabel ?? "Generate"}
        </button>
      </form>
    </header>
  );
}
