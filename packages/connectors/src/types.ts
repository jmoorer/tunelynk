export interface CatalogTrack {
  appleSongId: string;
  isrc?: string;
  title: string;
  // Raw display string ("Mumford & Sons", "Calvin Harris & Dua Lipa"). Not split
  // here because band names contain "&"; the matcher splits when comparing.
  artistName: string;
  // Only populated by lookupByIds/lookupByIsrc: search and top-songs results
  // carry no relationships.
  artistIds: string[];
  album: string;
  durationMs: number;
  explicit: boolean;
  artworkUrl?: string;
  previewUrl?: string;
}

export interface CatalogSource {
  search(query: string, opts?: { limit?: number }): Promise<CatalogTrack[]>;
  lookupByIsrc(isrcs: string[]): Promise<CatalogTrack[]>;
  lookupByIds(ids: string[]): Promise<CatalogTrack[]>;
  artistTopSongs(artistId: string): Promise<CatalogTrack[]>;
}
