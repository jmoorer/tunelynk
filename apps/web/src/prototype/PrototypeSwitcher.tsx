// PROTOTYPE — floating variant switcher. Dev only (see App.tsx).
import { useEffect } from "react";

export function PrototypeSwitcher({
  variants,
  current,
  status,
  onChange,
}: {
  variants: { key: string; name: string }[];
  current: string;
  status: string;
  onChange: (key: string) => void;
}) {
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const step = (delta: number) => {
    const next = variants[(index + delta + variants.length) % variants.length];
    if (next) onChange(next.key);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const v = variants[index];
  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-full border-2 border-fuchsia-500 bg-black px-4 py-2 font-mono text-xs text-white shadow-2xl">
      <span className="rounded bg-fuchsia-500 px-1.5 py-0.5 font-bold">
        PROTOTYPE
      </span>
      <button
        type="button"
        onClick={() => step(-1)}
        className="px-1 hover:text-fuchsia-300"
      >
        ←
      </button>
      <span className="min-w-44 text-center">
        {v?.key} ({v?.name})
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        className="px-1 hover:text-fuchsia-300"
      >
        →
      </button>
      <span className="border-l border-white/30 pl-3 text-white/70">
        {status}
      </span>
    </div>
  );
}
