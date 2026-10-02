export type TtlCache<V> = {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
};

// Map keeps insertion order, so the first key is the least recently used once
// every read re-inserts its entry.
export function createTtlCache<V>({
  max,
  ttlMs,
  now = Date.now,
}: {
  max: number;
  ttlMs: number;
  now?: () => number;
}): TtlCache<V> {
  const entries = new Map<string, { value: V; expiresAt: number }>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expiresAt <= now()) return undefined;
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      if (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
  };
}
