import type { CatalogTrack } from "@tunelynk/connectors";
import type { TrackKey } from "./llm/types";

// Starting thresholds from the spec; tune with the fixtures and the eval.
const TITLE_THRESHOLD = 0.85;
const ARTIST_THRESHOLD = 0.8;
const VARIANT_PENALTY = 0.3;
const VARIANT_WORDS =
  /\b(live|karaoke|cover|tribute|instrumental|made famous|originally performed)\b/g;
// Album names only count as variants with a clear marker: "Live Through This"
// and "LONG.LIVE.A$AP" are studio albums.
const ALBUM_VARIANT =
  /^live$|\blive (at|from|in|on)\b|[([]live\b|-\s*live\b|\bunplugged\b|\bkaraoke\b|\btribute\b|made famous|originally performed/;
const ALBUM_VARIANT_WORD =
  /\b(live|unplugged|karaoke|tribute|made famous|originally performed)\b/;
const ARTIST_SEPARATORS =
  /\s*(?:,|&|\/|\bfeat\.?|\bft\.?|\bx\b|\bwith\b|\band\b)\s*/i;

export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(
      /\s+-\s+.*\b(remaster(ed)?|version|edit|mix|mono|stereo|single|deluxe|live)\b.*$/,
      " ",
    )
    .replace(/\s(feat|ft)\.?\s.*$/, " ")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const compact = text.replace(/ /g, "");
  for (let i = 0; i < compact.length - 1; i++) {
    const gram = compact.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

export function dice(a: string, b: string): number {
  if (a.replace(/ /g, "") === b.replace(/ /g, "") && a.length > 1) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let total = 0;
  for (const n of left.values()) total += n;
  for (const n of right.values()) total += n;
  if (total === 0) return 0;
  let overlap = 0;
  for (const [gram, n] of left) overlap += Math.min(n, right.get(gram) ?? 0);
  return (2 * overlap) / total;
}

function best(lefts: string[], rights: string[]): number {
  let score = 0;
  for (const l of lefts)
    for (const r of rights) score = Math.max(score, dice(l, r));
  return score;
}

function titleVariants(title: string): string[] {
  const parts = title.split("/").map(normalize).filter(Boolean);
  return [normalize(title), ...(parts.length > 1 ? parts : [])];
}

function artistVariants(name: string): string[] {
  const parts = name.split(ARTIST_SEPARATORS).map(normalize).filter(Boolean);
  return [normalize(name), ...parts];
}

export function titleScore(a: string, b: string): number {
  return best(titleVariants(a), titleVariants(b));
}

export function artistScore(a: string, b: string): number {
  return best(artistVariants(a), artistVariants(b));
}

export type MatchScore = { title: number; artist: number; accepted: boolean };

const hasWord = (text: string, word: string) =>
  new RegExp(`\\b${word}\\b`).test(text);

function variantWords(track: CatalogTrack): string[] {
  const words: string[] = [
    ...(track.title.toLowerCase().match(VARIANT_WORDS) ?? []),
  ];
  const album = track.album.toLowerCase();
  if (ALBUM_VARIANT.test(album)) {
    const word = album.match(ALBUM_VARIANT_WORD)?.[0];
    if (word) words.push(word);
  }
  return words;
}

export function scoreMatch(
  candidate: TrackKey,
  track: CatalogTrack,
): MatchScore {
  const wanted = candidate.title.toLowerCase();
  // Penalize live/karaoke/cover/... versions unless the candidate asked for them.
  const penalty = variantWords(track).some((word) => !hasWord(wanted, word))
    ? VARIANT_PENALTY
    : 0;
  const title = titleScore(candidate.title, track.title) - penalty;
  const artist = artistScore(candidate.artist, track.artistName);
  return {
    title,
    artist,
    accepted: title >= TITLE_THRESHOLD && artist >= ARTIST_THRESHOLD,
  };
}

export function pickBest(
  candidate: TrackKey,
  tracks: CatalogTrack[],
): CatalogTrack | undefined {
  let winner: CatalogTrack | undefined;
  let winnerScore = -1;
  for (const track of tracks) {
    const score = scoreMatch(candidate, track);
    if (!score.accepted) continue;
    const combined = score.title + score.artist;
    if (combined > winnerScore) {
      winner = track;
      winnerScore = combined;
    }
  }
  return winner;
}
