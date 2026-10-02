import type { CatalogSource, CatalogTrack } from "@tunelynk/connectors";
import { EngineError, NotEnoughTracksError, RefusalError } from "./errors";
import type { LlmProvider } from "./llm/types";
import { artistScore, normalize, pickBest } from "./matcher";
import type {
  CandidateResult,
  ExcludedTrack,
  GeneratedTrack,
  GenerateInput,
  GenerateResult,
  Stage,
} from "./types";

const CANDIDATE_MULTIPLIER = 1.6;
const BACKFILL_PER_ARTIST = 2;
const PLAN_ARTIST_THRESHOLD = 0.8;
const MAX_NAME_LENGTH = 60;

export type GenerateDeps = { catalog: CatalogSource; llm: LlmProvider };

type SongRef = ExcludedTrack;

const primaryArtist = (name: string) =>
  name.split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i)[0] ?? name;

// Same song if it shares an Apple id or ISRC, or the same normalized title and
// primary artist (re-releases get new ISRCs).
function songKeys(song: SongRef): string[] {
  const keys = [
    `apple:${song.appleSongId}`,
    `song:${normalize(song.title)}|${normalize(primaryArtist(song.artistName))}`,
  ];
  if (song.isrc) keys.push(`isrc:${song.isrc}`);
  return keys;
}

function createSeen(initial: SongRef[]) {
  const keys = new Set<string>();
  const seen = {
    has: (song: SongRef) => songKeys(song).some((key) => keys.has(key)),
    add: (song: SongRef) => {
      for (const key of songKeys(song)) keys.add(key);
    },
  };
  for (const song of initial) seen.add(song);
  return seen;
}

export function interleave<T>(primary: T[], extra: T[]): T[] {
  const out: T[] = [];
  const gap = primary.length / (extra.length + 1);
  let next = 0;
  primary.forEach((item, i) => {
    out.push(item);
    while (next < extra.length && i + 1 >= gap * (next + 1)) {
      out.push(extra[next] as T);
      next++;
    }
  });
  out.push(...extra.slice(next));
  return out;
}

async function backfill(
  catalog: CatalogSource,
  tracks: GeneratedTrack[],
  planArtists: string[],
  needed: number,
  seen: ReturnType<typeof createSeen>,
): Promise<GeneratedTrack[]> {
  if (needed <= 0 || tracks.length === 0 || planArtists.length === 0) {
    return [];
  }

  // Search results carry no artist ids; one lookup hydrates them.
  const hydrated = await catalog
    .lookupByIds(tracks.map((t) => t.appleSongId))
    .catch((): CatalogTrack[] => []);

  const matchCounts = new Map<string, number>();
  for (const track of hydrated) {
    const artistId = track.artistIds[0];
    if (!artistId) continue;
    const inPlan = planArtists.some(
      (artist) =>
        artistScore(artist, track.artistName) >= PLAN_ARTIST_THRESHOLD,
    );
    if (inPlan) matchCounts.set(artistId, (matchCounts.get(artistId) ?? 0) + 1);
  }
  const artistIds = [...matchCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  const queues = await Promise.all(
    artistIds.map((id) =>
      catalog.artistTopSongs(id).catch((): CatalogTrack[] => []),
    ),
  );

  // Each round takes at most one song per artist.
  const extra: GeneratedTrack[] = [];
  for (let round = 0; round < BACKFILL_PER_ARTIST; round++) {
    for (const queue of queues) {
      if (extra.length >= needed) return extra;
      let next = queue.shift();
      while (next && seen.has(next)) next = queue.shift();
      if (next) {
        seen.add(next);
        extra.push({ ...next, source: "backfill" });
      }
    }
  }
  return extra;
}

export async function generate(
  input: GenerateInput,
  { catalog, llm }: GenerateDeps,
  onStage: (stage: Stage) => void = () => {},
): Promise<GenerateResult> {
  const { prompt, length, exclude = [] } = input;

  onStage("llm");
  const { output, usage } = await llm.generateCandidates({
    prompt,
    count: Math.ceil(length * CANDIDATE_MULTIPLIER),
    exclude: exclude.map((t) => ({ title: t.title, artist: t.artistName })),
  });
  if (output.refusal) throw new RefusalError(output.refusal, usage);

  const finish = async (): Promise<GenerateResult> => {
    onStage("matching");
    // The connector's shared limiter throttles these.
    const matches = await Promise.all(
      output.candidates.map(async (candidate) => {
        try {
          const results = await catalog.search(
            `${candidate.artist} ${candidate.title}`,
          );
          return { ok: true as const, track: pickBest(candidate, results) };
        } catch {
          return { ok: false as const };
        }
      }),
    );

    const seen = createSeen(exclude);
    const matched: GeneratedTrack[] = [];
    const candidates: CandidateResult[] = output.candidates.map((c, i) => {
      const base = { title: c.title, artist: c.artist };
      const match = matches[i];
      if (!match?.ok) return { ...base, status: "error" };
      if (!match.track) return { ...base, status: "unmatched" };
      const appleSongId = match.track.appleSongId;
      if (seen.has(match.track))
        return { ...base, status: "duplicate", appleSongId };
      seen.add(match.track);
      if (matched.length < length)
        matched.push({ ...match.track, source: "llm" });
      return { ...base, status: "matched", appleSongId };
    });

    const extra = await backfill(
      catalog,
      matched,
      output.plan.artists,
      length - matched.length,
      seen,
    );
    const tracks = interleave(matched, extra);

    const needed = Math.ceil(length / 2);
    if (tracks.length < needed) {
      throw new NotEnoughTracksError(tracks.length, needed, candidates, usage);
    }

    const name = output.name || prompt.trim().slice(0, MAX_NAME_LENGTH);
    return { name, tracks, candidates, usage };
  };

  // Anything thrown after the LLM call still owes its cost: keep usage attached.
  return finish().catch((err: unknown) => {
    if (err instanceof EngineError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new EngineError(
      `generate failed after the LLM call: ${reason}`,
      usage,
      {
        cause: err,
      },
    );
  });
}
