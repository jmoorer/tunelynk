import type { CatalogSource, CatalogTrack } from "../types";
import { createTtlCache, type TtlCache } from "./cache";
import type { AppleClient } from "./client";
import { type AppleSong, mapSongs } from "./mapSong";

type SearchResponse = { results?: { songs?: { data?: AppleSong[] } } };
type SongsResponse = { data?: AppleSong[] };

const DEFAULT_SEARCH_LIMIT = 5;
const ISRC_CHUNK = 25;
const IDS_CHUNK = 300;
const TOP_SONGS_LIMIT = "20";
const DAY_MS = 24 * 60 * 60 * 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function appleCatalog(
  client: AppleClient,
  cache: TtlCache<CatalogTrack[]> = createTtlCache({ max: 500, ttlMs: DAY_MS }),
): CatalogSource {
  async function cached(
    key: string,
    load: () => Promise<CatalogTrack[]>,
  ): Promise<CatalogTrack[]> {
    const hit = cache.get(key);
    if (hit) return hit;
    const value = await load();
    cache.set(key, value);
    return value;
  }

  async function songsBy(
    param: "filter[isrc]" | "ids",
    values: string[],
    size: number,
  ): Promise<CatalogTrack[]> {
    const pages = await Promise.all(
      chunk([...new Set(values)], size).map((part) =>
        client.get<SongsResponse>("/songs", { [param]: part.join(",") }),
      ),
    );
    return pages.flatMap((page) => mapSongs(page.data));
  }

  return {
    async search(query, { limit = DEFAULT_SEARCH_LIMIT } = {}) {
      const term = query.trim().replace(/\s+/g, " ");
      if (!term) return [];
      return cached(`search:${limit}:${term.toLowerCase()}`, async () => {
        const body = await client.get<SearchResponse>("/search", {
          types: "songs",
          limit: String(limit),
          term,
        });
        return mapSongs(body.results?.songs?.data);
      });
    },

    lookupByIsrc(isrcs) {
      return songsBy("filter[isrc]", isrcs, ISRC_CHUNK);
    },

    lookupByIds(ids) {
      return songsBy("ids", ids, IDS_CHUNK);
    },

    artistTopSongs(artistId) {
      return cached(`top:${artistId}`, async () => {
        const body = await client.get<SongsResponse>(
          `/artists/${encodeURIComponent(artistId)}/view/top-songs`,
          { limit: TOP_SONGS_LIMIT },
        );
        return mapSongs(body.data);
      });
    },
  };
}
