import { ErrorBanner } from "../components/ErrorBanner";
import { Shell } from "../components/Shell";
import { TopBar } from "../components/TopBar";
import { useCreateRun } from "../hooks/useCreateRun";

const EXAMPLES = [
  "upbeat 90s road trip",
  "rainy sunday morning jazz",
  "2000s pop punk anthems",
  "deep focus electronic",
];

export function Landing() {
  const create = useCreateRun();
  return (
    <Shell>
      <TopBar
        busyLabel={create.pending ? "Starting…" : undefined}
        onSubmit={create.submit}
      />
      {create.error && <ErrorBanner {...create.error} />}
      <section className="mx-auto max-w-6xl px-6 py-24 text-center">
        <h1 className="text-5xl font-black tracking-tight sm:text-7xl">
          Type a vibe.
          <br />
          <span className="bg-gradient-to-r from-fuchsia-400 via-rose-400 to-amber-300 bg-clip-text text-transparent">
            Get a playlist.
          </span>
        </h1>
        <p className="mt-6 text-white/50">
          Real tracks from Apple Music, with 30-second previews. No account
          needed.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={create.pending}
              onClick={() => create.submit(example)}
              className="rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/20 disabled:opacity-40"
            >
              {example}
            </button>
          ))}
        </div>
      </section>
    </Shell>
  );
}
