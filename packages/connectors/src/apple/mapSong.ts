import type { CatalogTrack } from "../types";

// The subset of Apple's song resource we read. Everything is optional because
// catalog items are inconsistent (no previews, no artwork, no ISRC).
export type AppleSong = {
  id: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    isrc?: string;
    contentRating?: string;
    artwork?: { url?: string };
    previews?: { url?: string }[];
  };
  relationships?: { artists?: { data?: { id: string }[] } };
};

const ARTWORK_SIZE = "300";

export function mapSong(song: AppleSong): CatalogTrack | undefined {
  const a = song.attributes;
  if (!a?.name || !a.artistName) return undefined;
  return {
    appleSongId: song.id,
    isrc: a.isrc,
    title: a.name,
    artistName: a.artistName,
    artistIds: song.relationships?.artists?.data?.map((d) => d.id) ?? [],
    album: a.albumName ?? "",
    durationMs: a.durationInMillis ?? 0,
    explicit: a.contentRating === "explicit",
    artworkUrl: a.artwork?.url
      ?.replace("{w}", ARTWORK_SIZE)
      .replace("{h}", ARTWORK_SIZE),
    previewUrl: a.previews?.[0]?.url,
  };
}

export function mapSongs(songs: AppleSong[] | undefined): CatalogTrack[] {
  return (songs ?? []).flatMap((song) => {
    const track = mapSong(song);
    return track ? [track] : [];
  });
}
