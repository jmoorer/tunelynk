# Slice A: Apple Catalog Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `@tunelynk/connectors` package whose `createAppleCatalog(config)` returns a `CatalogSource` that searches, looks up by ISRC or id, and fetches artist top songs from the Apple Music catalog through one rate-limited, retrying, token-caching client.

**Architecture:** Small single-purpose modules composed in `apple/index.ts`. `devToken` signs and caches the ES256 JWT. `limiter` is a process-wide token bucket with a concurrency cap. `client` builds URLs, retries 429/5xx/network errors with jittered backoff, and re-signs once on 401. `catalog` maps Apple JSON to `CatalogTrack` and caches search and top songs in a TTL LRU. Every I/O dependency (`fetch`, clock, sleep, random) is injectable, so the unit tests need no network and no msw.

**Tech Stack:** TypeScript 7, Node 22 `node:crypto`, Vitest 5 (fake timers), Biome, pnpm workspaces, Turborepo.

**Spec:** `docs/superpowers/specs/2026-10-01-engine-guest-generate-design.md` (sections "Interfaces", "Apple connector", "Testing → A"). Rate-limit numbers come from `docs/superpowers/spikes/2026-09-30-apple-catalog-rate-limits.md`.

## Global Constraints

- Package name `@tunelynk/connectors`, ESM (`"type": "module"`), `exports: { ".": "./src/index.ts" }`, same as `packages/db` and `packages/shared`.
- tsconfig extends `@tunelynk/config/tsconfig.node.json` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`: use `import type` for types).
- No runtime dependencies. Dev dependencies only: `@tunelynk/config`, `@types/node`, `typescript`, `vitest` (same version ranges as `packages/db`).
- Base URL `https://api.music.apple.com/v1`; paths are `/catalog/{storefront}/…`.
- Limiter defaults from the spike: 8 req/s refill, burst 10, 4 in flight. A 429 drains the shared bucket.
- Retry: 429, 5xx, and network errors; exponential backoff with full jitter, base 250 ms, cap 4 s, max 4 retries (5 attempts). 401 → invalidate token and retry once, not counted as a retry. Other 4xx throw immediately.
- Developer token: ES256, `kid = keyId`, `iss = teamId`, 1 h expiry, re-signed after 50 min (3000 s) or on `invalidate()`.
- `APPLE_PRIVATE_KEY` accepts base64 of the `.p8` PEM, a bare base64 PKCS#8 DER body, or raw PEM (literal `\n` allowed).
- `artistName` is never split in the connector.
- Cache: 500 entries, 24 h TTL, search and top songs only.
- Live tests run only with `APPLE_LIVE=1`; `pnpm test` / CI must never hit Apple.
- Format and lint with Biome (`pnpm --filter @tunelynk/connectors lint`); two-space indent.

## Review Focus

1. **Search terms with `+`, `&`, `/`, or non-ASCII** (e.g. "Frank Ocean Pink + White", "Khruangbin Maria También"). Expected: sent URL-encoded (`+` → `%2B`), never mangled. Pinned in Task 5.
2. **Searches that find nothing.** Apple returns `{"results":{}}` with no `songs` key. Expected: `[]`, not a crash. Pinned in Task 6.
3. **Catalog songs missing `previews`, `artwork`, `isrc`, or `contentRating`.** Expected: those fields are `undefined` / `false` and the track is still returned; a song with no `name` or `artistName` is skipped. Pinned in Task 1.
4. **Network failures** (`fetch` rejects with `TypeError: fetch failed`). Expected: retried like a 5xx, and the original error surfaces after the last retry. Pinned in Task 5.
5. **A long-running server crossing the token's 1 h expiry.** Expected: the token is re-signed after 50 min without a restart, and a 401 forces a re-sign. Pinned in Task 2 (time) and Task 5 (401).

---

## File Structure

```
packages/connectors/
  package.json
  tsconfig.json
  vitest.config.ts                 loads root .env for live tests
  src/
    index.ts                       public exports
    types.ts                       CatalogTrack, CatalogSource
    apple/
      index.ts                     createAppleCatalog(config): wires token + limiter + client + catalog
      mapSong.ts                   Apple song JSON → CatalogTrack
      mapSong.test.ts
      devToken.ts                  loadPrivateKey, createDeveloperToken
      devToken.test.ts
      limiter.ts                   createLimiter
      limiter.test.ts
      cache.ts                     createTtlCache
      cache.test.ts
      client.ts                    createAppleClient, AppleApiError, backoffDelay
      client.test.ts
      catalog.ts                   appleCatalog(client, cache)
      catalog.test.ts
      index.test.ts                createAppleCatalog end-to-end with injected fetch
      catalog.live.test.ts         APPLE_LIVE=1 smoke against the real API
      __fixtures__/
        search.json
        songs.json
        top-songs.json
.env.example                       add APPLE_* vars (modify)
```

---

### Task 1: Package scaffold, catalog types, and song mapping

**Files:**
- Create: `packages/connectors/package.json`, `packages/connectors/tsconfig.json`, `packages/connectors/vitest.config.ts`
- Create: `packages/connectors/src/index.ts`, `packages/connectors/src/types.ts`, `packages/connectors/src/apple/mapSong.ts`
- Create: `packages/connectors/src/apple/__fixtures__/search.json`, `songs.json`, `top-songs.json`
- Test: `packages/connectors/src/apple/mapSong.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CatalogTrack { appleSongId: string; isrc?: string; title: string; artistName: string; artistIds: string[]; album: string; durationMs: number; explicit: boolean; artworkUrl?: string; previewUrl?: string }`
  - `interface CatalogSource { search(query: string, opts?: { limit?: number }): Promise<CatalogTrack[]>; lookupByIsrc(isrcs: string[]): Promise<CatalogTrack[]>; lookupByIds(ids: string[]): Promise<CatalogTrack[]>; artistTopSongs(artistId: string): Promise<CatalogTrack[]> }`
  - `type AppleSong` (raw Apple song resource), `mapSong(song: AppleSong): CatalogTrack | undefined`, `mapSongs(songs: AppleSong[] | undefined): CatalogTrack[]`

- [ ] **Step 1: Create the package files**

`packages/connectors/package.json`:
```json
{
  "name": "@tunelynk/connectors",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "vitest run --exclude \"src/**/*.live.test.ts\"",
    "test:live": "APPLE_LIVE=1 vitest run live"
  },
  "devDependencies": {
    "@tunelynk/config": "workspace:*",
    "@types/node": "^26.6.3",
    "typescript": "^7.0.2",
    "vitest": "^5.0.2"
  }
}
```

`packages/connectors/tsconfig.json`:
```json
{
  "extends": "@tunelynk/config/tsconfig.node.json",
  "include": ["src", "vitest.config.ts"]
}
```

`packages/connectors/vitest.config.ts`:
```ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Load the root .env (if present) so the live smoke test can sign real tokens.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({});
```

`packages/connectors/src/types.ts`:
```ts
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
```

`packages/connectors/src/index.ts` (grows in later tasks):
```ts
export * from "./types";
```

Run: `pnpm install`
Expected: lockfile updated, `@tunelynk/connectors` linked into the workspace.

- [ ] **Step 2: Add the recorded fixtures**

These are trimmed real responses recorded 2026-10-01 from storefront `us`.

`packages/connectors/src/apple/__fixtures__/search.json`:
```json
{
  "results": {
    "songs": {
      "data": [
        {
          "id": "1109715168",
          "type": "songs",
          "attributes": {
            "albumName": "In Rainbows",
            "artistName": "Radiohead",
            "artwork": {
              "url": "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/dd/50/c7/dd50c790-99ac-d3d0-5ab8-e3891fb8fd52/634904032463.png/{w}x{h}bb.jpg"
            },
            "durationInMillis": 318187,
            "isrc": "GBSTK0700004",
            "name": "Weird Fishes / Arpeggi",
            "previews": [
              {
                "url": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/3a/12/eb/3a12ebaf-89c1-1ac9-6821-3a1de510ef51/mzaf_14543910941982290973.plus.aac.p.m4a"
              }
            ]
          }
        },
        {
          "id": "813858377",
          "type": "songs",
          "attributes": {
            "albumName": "Der Prinz",
            "artistName": "MG3: Montreal Guitare Trio",
            "artwork": {
              "url": "https://is1-ssl.mzstatic.com/image/thumb/Music6/v4/fd/ad/56/fdad5603-7cba-938e-e6b4-a1b13809ada3/774204876821.tif/{w}x{h}bb.jpg"
            },
            "durationInMillis": 283754,
            "isrc": "CA2Z61400010",
            "name": "Weird Fishes",
            "previews": [
              {
                "url": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview115/v4/49/27/7a/49277aa2-424c-22ea-f35a-98ed48f7c47d/mzaf_13790328913826371154.plus.aac.p.m4a"
              }
            ]
          }
        }
      ]
    }
  }
}
```

`packages/connectors/src/apple/__fixtures__/songs.json`:
```json
{
  "data": [
    {
      "id": "1109715168",
      "type": "songs",
      "attributes": {
        "albumName": "In Rainbows",
        "artistName": "Radiohead",
        "artwork": {
          "url": "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/dd/50/c7/dd50c790-99ac-d3d0-5ab8-e3891fb8fd52/634904032463.png/{w}x{h}bb.jpg"
        },
        "durationInMillis": 318187,
        "isrc": "GBSTK0700004",
        "name": "Weird Fishes / Arpeggi",
        "previews": [
          {
            "url": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/3a/12/eb/3a12ebaf-89c1-1ac9-6821-3a1de510ef51/mzaf_14543910941982290973.plus.aac.p.m4a"
          }
        ]
      },
      "relationships": {
        "artists": {
          "data": [{ "id": "657515", "type": "artists" }]
        }
      }
    }
  ]
}
```

`packages/connectors/src/apple/__fixtures__/top-songs.json`:
```json
{
  "data": [
    {
      "id": "1097862231",
      "type": "songs",
      "attributes": {
        "albumName": "Pablo Honey",
        "artistName": "Radiohead",
        "artwork": {
          "url": "https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/78/a4/ec/78a4ec7b-c6d6-c9c8-441b-660486e56a89/634904077969.png/{w}x{h}bb.jpg"
        },
        "durationInMillis": 238640,
        "isrc": "GBAYE9200070",
        "name": "Creep",
        "previews": [
          {
            "url": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/91/07/a1/9107a13f-9179-34a9-89d6-a9569777195c/mzaf_9360083878255871917.plus.aac.p.m4a"
          }
        ],
        "contentRating": "explicit"
      }
    },
    {
      "id": "1097861834",
      "type": "songs",
      "attributes": {
        "albumName": "OK Computer",
        "artistName": "Radiohead",
        "artwork": {
          "url": "https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/07/60/ba/0760ba0f-148c-b18f-d0ff-169ee96f3af5/634904078164.png/{w}x{h}bb.jpg"
        },
        "durationInMillis": 299560,
        "isrc": "GBAYE9701374",
        "name": "Let Down",
        "previews": [
          {
            "url": "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/cd/65/58/cd6558df-2ba2-6f8e-25a0-d2db94494f74/mzaf_5583409847288875892.plus.aac.p.m4a"
          }
        ]
      }
    }
  ]
}
```

- [ ] **Step 3: Write the failing test**

`packages/connectors/src/apple/mapSong.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import search from "./__fixtures__/search.json";
import songs from "./__fixtures__/songs.json";
import topSongs from "./__fixtures__/top-songs.json";
import { type AppleSong, mapSong, mapSongs } from "./mapSong";

describe("mapSong", () => {
  it("maps a search result", () => {
    const [first] = mapSongs(search.results.songs.data);
    expect(first).toEqual({
      appleSongId: "1109715168",
      isrc: "GBSTK0700004",
      title: "Weird Fishes / Arpeggi",
      artistName: "Radiohead",
      artistIds: [],
      album: "In Rainbows",
      durationMs: 318187,
      explicit: false,
      artworkUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/dd/50/c7/dd50c790-99ac-d3d0-5ab8-e3891fb8fd52/634904032463.png/300x300bb.jpg",
      previewUrl:
        "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/3a/12/eb/3a12ebaf-89c1-1ac9-6821-3a1de510ef51/mzaf_14543910941982290973.plus.aac.p.m4a",
    });
  });

  it("reads artist ids from relationships", () => {
    expect(mapSongs(songs.data)[0]?.artistIds).toEqual(["657515"]);
  });

  it("sets explicit only for contentRating 'explicit'", () => {
    expect(mapSongs(topSongs.data).map((t) => t.explicit)).toEqual([
      true,
      false,
    ]);
  });

  it("keeps a song with missing optional attributes", () => {
    const bare: AppleSong = {
      id: "1",
      attributes: { name: "Song", artistName: "Mumford & Sons" },
    };
    expect(mapSong(bare)).toEqual({
      appleSongId: "1",
      isrc: undefined,
      title: "Song",
      artistName: "Mumford & Sons",
      artistIds: [],
      album: "",
      durationMs: 0,
      explicit: false,
      artworkUrl: undefined,
      previewUrl: undefined,
    });
  });

  it("skips songs without a name or artist", () => {
    expect(mapSong({ id: "1", attributes: { artistName: "A" } })).toBe(
      undefined,
    );
    expect(mapSong({ id: "2" })).toBe(undefined);
    expect(mapSongs([{ id: "2" }])).toEqual([]);
  });

  it("treats undefined input as no songs", () => {
    expect(mapSongs(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/connectors test`
Expected: FAIL, `Failed to resolve import "./mapSong"`.

- [ ] **Step 5: Implement**

`packages/connectors/src/apple/mapSong.ts`:
```ts
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
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/connectors test && pnpm --filter @tunelynk/connectors typecheck && pnpm --filter @tunelynk/connectors lint`
Expected: 6 tests PASS; typecheck and lint clean. If Biome reports formatting, run `pnpm format` and re-run.

- [ ] **Step 7: Commit**

```bash
git add packages/connectors pnpm-lock.yaml
git commit -m "feat(connectors): scaffold package with catalog types and Apple song mapping"
```

---

### Task 2: Developer token

**Files:**
- Create: `packages/connectors/src/apple/devToken.ts`
- Test: `packages/connectors/src/apple/devToken.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadPrivateKey(raw: string): KeyObject`
  - `type DeveloperTokenOptions = { teamId: string; keyId: string; privateKey: string; ttlSeconds?: number; refreshAfterSeconds?: number; now?: () => number }`
  - `type DeveloperToken = { get(): string; invalidate(): void }`
  - `createDeveloperToken(options: DeveloperTokenOptions): DeveloperToken`. Parses the key at construction, so a bad key throws at startup.

- [ ] **Step 1: Write the failing test**

`packages/connectors/src/apple/devToken.test.ts`:
```ts
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeveloperToken, loadPrivateKey } from "./devToken";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const base64Pem = Buffer.from(pem).toString("base64");
const base64Der = privateKey
  .export({ type: "pkcs8", format: "der" })
  .toString("base64");

const decode = (part: string | undefined) =>
  JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));

function verifies(token: string): boolean {
  const [header, payload, signature] = token.split(".");
  return verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature ?? "", "base64url"),
  );
}

describe("loadPrivateKey", () => {
  it.each([
    ["raw PEM", pem],
    ["PEM with literal \\n", pem.replace(/\n/g, "\\n")],
    ["base64 of the PEM", base64Pem],
    ["base64 PKCS#8 DER", base64Der],
  ])("accepts %s", (_label, raw) => {
    expect(loadPrivateKey(raw).asymmetricKeyType).toBe("ec");
  });

  it("throws on garbage", () => {
    expect(() => loadPrivateKey("not a key")).toThrow();
  });
});

describe("createDeveloperToken", () => {
  const options = {
    teamId: "TEAM123",
    keyId: "KEY456",
    privateKey: base64Pem,
  };

  it("signs an ES256 JWT with the Apple claims", () => {
    const now = () => 1_700_000_000_000;
    const token = createDeveloperToken({ ...options, now }).get();
    const [header, payload] = token.split(".");
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY456" });
    expect(decode(payload)).toEqual({
      iss: "TEAM123",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(verifies(token)).toBe(true);
  });

  it("reuses the token for 50 minutes, then re-signs", () => {
    let nowMs = 1_700_000_000_000;
    const token = createDeveloperToken({ ...options, now: () => nowMs });
    const first = token.get();

    nowMs += 2999 * 1000;
    expect(token.get()).toBe(first);

    nowMs += 1000; // 3000 s after signing
    const second = token.get();
    expect(second).not.toBe(first);
    expect(decode(second.split(".")[1]).iat).toBe(1_700_003_000);
  });

  it("re-signs after invalidate()", () => {
    let nowMs = 1_700_000_000_000;
    const token = createDeveloperToken({ ...options, now: () => nowMs });
    token.get();
    nowMs += 1000;
    token.invalidate();
    expect(decode(token.get().split(".")[1]).iat).toBe(1_700_000_001);
  });

  it("fails at construction on a bad key", () => {
    expect(() =>
      createDeveloperToken({ ...options, privateKey: "bad" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/connectors test devToken`
Expected: FAIL, `Failed to resolve import "./devToken"`.

- [ ] **Step 3: Implement**

`packages/connectors/src/apple/devToken.ts`:
```ts
import { createPrivateKey, type KeyObject, sign } from "node:crypto";

// Accepts base64 of the whole .p8 PEM, a bare base64 PKCS#8 DER body, or raw PEM
// (with real or literal "\n" line breaks).
export function loadPrivateKey(raw: string): KeyObject {
  if (raw.includes("BEGIN PRIVATE KEY")) {
    return createPrivateKey(raw.replace(/\\n/g, "\n"));
  }
  const decoded = Buffer.from(raw.trim(), "base64");
  const text = decoded.toString("utf8");
  if (text.includes("BEGIN PRIVATE KEY")) return createPrivateKey(text);
  return createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
}

export type DeveloperTokenOptions = {
  teamId: string;
  keyId: string;
  privateKey: string;
  ttlSeconds?: number;
  refreshAfterSeconds?: number;
  now?: () => number;
};

export type DeveloperToken = {
  get(): string;
  invalidate(): void;
};

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

export function createDeveloperToken({
  teamId,
  keyId,
  privateKey,
  ttlSeconds = 3600,
  refreshAfterSeconds = 3000,
  now = Date.now,
}: DeveloperTokenOptions): DeveloperToken {
  const key = loadPrivateKey(privateKey);
  let cached: { token: string; signedAt: number } | undefined;

  const signToken = (iat: number) => {
    const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
    const payload = b64url(
      JSON.stringify({ iss: teamId, iat, exp: iat + ttlSeconds }),
    );
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    return `${header}.${payload}.${b64url(signature)}`;
  };

  return {
    get() {
      const nowSeconds = Math.floor(now() / 1000);
      if (!cached || nowSeconds - cached.signedAt >= refreshAfterSeconds) {
        cached = { token: signToken(nowSeconds), signedAt: nowSeconds };
      }
      return cached.token;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
```

- [ ] **Step 4: Run tests and lint**

Run: `pnpm --filter @tunelynk/connectors test devToken && pnpm --filter @tunelynk/connectors lint`
Expected: 9 tests PASS (4 loader cases + 1 garbage + 4 token); lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/apple/devToken.ts packages/connectors/src/apple/devToken.test.ts
git commit -m "feat(connectors): sign and cache Apple developer tokens"
```

---

### Task 3: Rate limiter

**Files:**
- Create: `packages/connectors/src/apple/limiter.ts`
- Test: `packages/connectors/src/apple/limiter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LimiterOptions = { rps: number; burst: number; concurrency: number; now?: () => number }`
  - `type Limiter = { schedule<T>(task: () => Promise<T>): Promise<T>; drain(): void }`
  - `createLimiter(options: LimiterOptions): Limiter`. FIFO. A task starts only when a token is available and fewer than `concurrency` tasks are in flight. `drain()` empties the bucket.

- [ ] **Step 1: Write the failing test**

`packages/connectors/src/apple/limiter.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLimiter } from "./limiter";

// Drains multi-hop promise chains (task → resolve → finally → pump → next task).
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// Advance fake time, then let the tasks that the timer released start.
async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a burst immediately, then refills at rps", async () => {
    const limiter = createLimiter({ rps: 8, burst: 10, concurrency: 100 });
    let started = 0;
    for (let i = 0; i < 12; i++) {
      limiter.schedule(async () => {
        started++;
      });
    }
    await flush();
    expect(started).toBe(10);

    await tick(124);
    expect(started).toBe(10);
    await tick(1); // 125 ms = 1 token at 8/s
    expect(started).toBe(11);
    await tick(125);
    expect(started).toBe(12);
  });

  it("never runs more than `concurrency` tasks at once", async () => {
    const limiter = createLimiter({ rps: 100, burst: 100, concurrency: 4 });
    const gates = Array.from({ length: 6 }, deferred);
    let running = 0;
    let maxRunning = 0;
    for (const gate of gates) {
      limiter.schedule(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running--;
      });
    }
    await flush();
    expect(running).toBe(4);

    gates[0]?.resolve();
    await flush();
    expect(running).toBe(4); // the 5th started in the freed slot

    for (const gate of gates) gate.resolve();
    await flush();
    expect(maxRunning).toBe(4);
    expect(running).toBe(0);
  });

  it("drain() makes the next task wait for a fresh token", async () => {
    const limiter = createLimiter({ rps: 8, burst: 10, concurrency: 4 });
    limiter.drain();
    let started = false;
    limiter.schedule(async () => {
      started = true;
    });
    await tick(124);
    expect(started).toBe(false);
    await tick(1);
    expect(started).toBe(true);
  });

  it("returns the task's value and propagates its rejection", async () => {
    const limiter = createLimiter({ rps: 8, burst: 10, concurrency: 1 });
    const ok = limiter.schedule(async () => 42);
    const bad = limiter.schedule(async () => {
      throw new Error("boom");
    });
    const after = limiter.schedule(async () => "next");
    await flush();
    await expect(ok).resolves.toBe(42);
    await expect(bad).rejects.toThrow("boom");
    await expect(after).resolves.toBe("next"); // a failure frees its slot
  });

  it("treats a synchronous throw like a rejection", async () => {
    const limiter = createLimiter({ rps: 8, burst: 10, concurrency: 1 });
    const bad = limiter.schedule(() => {
      throw new Error("sync");
    });
    const after = limiter.schedule(async () => "next");
    await flush();
    await expect(bad).rejects.toThrow("sync");
    await expect(after).resolves.toBe("next");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/connectors test limiter`
Expected: FAIL, `Failed to resolve import "./limiter"`.

- [ ] **Step 3: Implement**

`packages/connectors/src/apple/limiter.ts`:
```ts
export type LimiterOptions = {
  rps: number;
  burst: number;
  concurrency: number;
  now?: () => number;
};

export type Limiter = {
  schedule<T>(task: () => Promise<T>): Promise<T>;
  // Empty the bucket so every caller backs off together (used after a 429).
  drain(): void;
};

// Token bucket plus a concurrency cap. One instance per process: Apple's budget
// belongs to the developer token, not to a run.
export function createLimiter({
  rps,
  burst,
  concurrency,
  now = Date.now,
}: LimiterOptions): Limiter {
  let tokens = burst;
  let lastRefill = now();
  let inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Array<() => void> = [];

  const refill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - lastRefill) / 1000) * rps);
    lastRefill = t;
  };

  const pump = () => {
    refill();
    while (queue.length > 0 && inFlight < concurrency && tokens >= 1) {
      tokens -= 1;
      inFlight += 1;
      queue.shift()?.();
    }
    if (queue.length > 0 && inFlight < concurrency && !timer) {
      const waitMs = Math.ceil(((1 - tokens) / rps) * 1000);
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, waitMs);
    }
  };

  return {
    schedule(task) {
      return new Promise((resolve, reject) => {
        queue.push(() => {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              inFlight -= 1;
              pump();
            });
        });
        pump();
      });
    },
    drain() {
      refill();
      tokens = 0;
    },
  };
}
```

- [ ] **Step 4: Run tests and lint**

Run: `pnpm --filter @tunelynk/connectors test limiter && pnpm --filter @tunelynk/connectors lint`
Expected: 5 tests PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/apple/limiter.ts packages/connectors/src/apple/limiter.test.ts
git commit -m "feat(connectors): add process-wide token-bucket limiter for Apple calls"
```

---

### Task 4: TTL LRU cache

**Files:**
- Create: `packages/connectors/src/apple/cache.ts`
- Test: `packages/connectors/src/apple/cache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TtlCache<V> = { get(key: string): V | undefined; set(key: string, value: V): void }`
  - `createTtlCache<V>(options: { max: number; ttlMs: number; now?: () => number }): TtlCache<V>`. Evicts the least recently used entry when over `max`; `get` refreshes recency; expired entries read as missing.

- [ ] **Step 1: Write the failing test**

`packages/connectors/src/apple/cache.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTtlCache } from "./cache";

describe("createTtlCache", () => {
  it("returns what was set", () => {
    const cache = createTtlCache<number>({ max: 2, ttlMs: 1000 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(undefined);
  });

  it("expires entries after ttlMs", () => {
    let nowMs = 0;
    const cache = createTtlCache<number>({
      max: 2,
      ttlMs: 1000,
      now: () => nowMs,
    });
    cache.set("a", 1);
    nowMs = 999;
    expect(cache.get("a")).toBe(1);
    nowMs = 1000;
    expect(cache.get("a")).toBe(undefined);
  });

  it("evicts the least recently used entry", () => {
    const cache = createTtlCache<number>({ max: 2, ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // a is now most recent
    cache.set("c", 3);
    expect(cache.get("b")).toBe(undefined);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("overwriting a key does not grow the cache", () => {
    const cache = createTtlCache<number>({ max: 2, ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("a", 2);
    cache.set("b", 3);
    expect(cache.get("a")).toBe(2);
    expect(cache.get("b")).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/connectors test cache`
Expected: FAIL, `Failed to resolve import "./cache"`.

- [ ] **Step 3: Implement**

`packages/connectors/src/apple/cache.ts`:
```ts
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
```

- [ ] **Step 4: Run tests and lint**

Run: `pnpm --filter @tunelynk/connectors test cache && pnpm --filter @tunelynk/connectors lint`
Expected: 4 tests PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/apple/cache.ts packages/connectors/src/apple/cache.test.ts
git commit -m "feat(connectors): add TTL LRU cache"
```

---

### Task 5: HTTP client with retry and token refresh

**Files:**
- Create: `packages/connectors/src/apple/client.ts`
- Test: `packages/connectors/src/apple/client.test.ts`

**Interfaces:**
- Consumes: `DeveloperToken` (Task 2), `Limiter` (Task 3). Tests use hand-written fakes of both.
- Produces:
  - `class AppleApiError extends Error { readonly status: number; readonly path: string }`
  - `backoffDelay(retry: number, random: () => number): number`: full jitter, `floor(random() * min(4000, 250 * 2^retry))`
  - `type AppleClientOptions = { token: DeveloperToken; limiter: Limiter; storefront: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; random?: () => number }`
  - `type AppleClient = { get<T>(path: string, params?: Record<string, string>): Promise<T> }`. `path` is relative to `/v1/catalog/{storefront}` and starts with `/`.
  - `createAppleClient(options: AppleClientOptions): AppleClient`

- [ ] **Step 1: Write the failing test**

`packages/connectors/src/apple/client.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { AppleApiError, backoffDelay, createAppleClient } from "./client";
import type { DeveloperToken } from "./devToken";
import type { Limiter } from "./limiter";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const empty = (status: number) => new Response(null, { status });

function setup(responses: Array<Response | Error>) {
  let signed = 0;
  const token: DeveloperToken = {
    get: () => `tok${signed}`,
    invalidate: vi.fn(() => {
      signed++;
    }),
  };
  const limiter: Limiter = {
    schedule: (task) => task(),
    drain: vi.fn(),
  };
  const fetch = vi.fn(async (_url: URL, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const client = createAppleClient({
    token,
    limiter,
    storefront: "us",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  return { client, fetch, token, limiter, sleeps };
}

describe("createAppleClient", () => {
  it("builds the catalog URL, encodes params, and sends the token", async () => {
    const { client, fetch } = setup([json({ ok: 1 })]);
    const body = await client.get("/search", {
      types: "songs",
      term: "Frank Ocean Pink + White & Khruangbin Maria También",
    });
    expect(body).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url?.origin + (url?.pathname ?? "")).toBe(
      "https://api.music.apple.com/v1/catalog/us/search",
    );
    expect(url?.search).toBe(
      "?types=songs&term=Frank+Ocean+Pink+%2B+White+%26+Khruangbin+Maria+Tambi%C3%A9n",
    );
    expect(url?.searchParams.get("term")).toBe(
      "Frank Ocean Pink + White & Khruangbin Maria También",
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok0");
  });

  it("retries 429 with backoff and drains the shared limiter", async () => {
    const { client, limiter, sleeps } = setup([
      empty(429),
      empty(429),
      json({ ok: 1 }),
    ]);
    await expect(client.get("/search")).resolves.toEqual({ ok: 1 });
    expect(limiter.drain).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([125, 250]); // 0.5 × 250, 0.5 × 500
  });

  it("gives up after 4 retries on 5xx", async () => {
    const { client, fetch, sleeps } = setup(
      Array.from({ length: 5 }, () => empty(503)),
    );
    const err = await client.get("/search").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppleApiError);
    expect(err).toMatchObject({ status: 503, path: "/search" });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(sleeps).toHaveLength(4);
  });

  it("retries network errors and surfaces the last one", async () => {
    const { client } = setup([
      new TypeError("fetch failed"),
      json({ ok: 1 }),
    ]);
    await expect(client.get("/search")).resolves.toEqual({ ok: 1 });

    const failing = setup(
      Array.from({ length: 5 }, () => new TypeError("fetch failed")),
    );
    await expect(failing.client.get("/search")).rejects.toThrow("fetch failed");
  });

  it("re-signs the token once on 401", async () => {
    const { client, fetch, token, sleeps } = setup([
      empty(401),
      json({ ok: 1 }),
    ]);
    await expect(client.get("/search")).resolves.toEqual({ ok: 1 });
    expect(token.invalidate).toHaveBeenCalledTimes(1);
    const auth = fetch.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("Authorization"),
    );
    expect(auth).toEqual(["Bearer tok0", "Bearer tok1"]);
    expect(sleeps).toEqual([]);
  });

  it("throws on a second 401", async () => {
    const { client, fetch } = setup([empty(401), empty(401)]);
    await expect(client.get("/search")).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws other 4xx immediately", async () => {
    const { client, fetch } = setup([empty(404)]);
    await expect(client.get("/songs/x")).rejects.toMatchObject({
      status: 404,
      path: "/songs/x",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("backoffDelay", () => {
  it("doubles from 250 ms and caps at 4 s", () => {
    const max = () => 0.999999;
    expect(backoffDelay(0, max)).toBe(249);
    expect(backoffDelay(1, max)).toBe(499);
    expect(backoffDelay(4, max)).toBe(3999);
    expect(backoffDelay(10, max)).toBe(3999);
    expect(backoffDelay(3, () => 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/connectors test client`
Expected: FAIL, `Failed to resolve import "./client"`.

- [ ] **Step 3: Implement**

`packages/connectors/src/apple/client.ts`:
```ts
import type { DeveloperToken } from "./devToken";
import type { Limiter } from "./limiter";

const BASE_URL = "https://api.music.apple.com/v1";
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4000;

export class AppleApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`Apple Music API returned ${status} for ${path}`);
    this.name = "AppleApiError";
    this.status = status;
    this.path = path;
  }
}

// Exponential backoff with full jitter. Apple sends no Retry-After (spike #7).
export function backoffDelay(retry: number, random: () => number): number {
  return Math.floor(
    random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry),
  );
}

export type AppleClientOptions = {
  token: DeveloperToken;
  limiter: Limiter;
  storefront: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type AppleClient = {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createAppleClient({
  token,
  limiter,
  storefront,
  fetch: fetchImpl = fetch,
  sleep = defaultSleep,
  random = Math.random,
}: AppleClientOptions): AppleClient {
  return {
    async get<T>(path: string, params: Record<string, string> = {}) {
      const url = new URL(`${BASE_URL}/catalog/${storefront}${path}`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      let retries = 0;
      let resigned = false;
      for (;;) {
        // Each attempt, retries included, spends a limiter token.
        const result = await limiter
          .schedule(() =>
            fetchImpl(url, {
              headers: { Authorization: `Bearer ${token.get()}` },
            }),
          )
          .catch((err: unknown) => err);

        if (result instanceof Response) {
          if (result.ok) return (await result.json()) as T;
          if (result.status === 401 && !resigned) {
            resigned = true;
            token.invalidate();
            continue;
          }
          const retryable = result.status === 429 || result.status >= 500;
          if (!retryable || retries >= MAX_RETRIES) {
            throw new AppleApiError(result.status, path);
          }
          if (result.status === 429) limiter.drain();
        } else if (retries >= MAX_RETRIES) {
          throw result;
        }

        await sleep(backoffDelay(retries, random));
        retries++;
      }
    },
  };
}
```

- [ ] **Step 4: Run tests and lint**

Run: `pnpm --filter @tunelynk/connectors test client && pnpm --filter @tunelynk/connectors lint`
Expected: 8 tests PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/apple/client.ts packages/connectors/src/apple/client.test.ts
git commit -m "feat(connectors): add Apple HTTP client with jittered retry and token refresh"
```

---

### Task 6: Catalog operations

**Files:**
- Create: `packages/connectors/src/apple/catalog.ts`
- Test: `packages/connectors/src/apple/catalog.test.ts`

**Interfaces:**
- Consumes: `AppleClient` (Task 5), `TtlCache`/`createTtlCache` (Task 4), `mapSongs`/`AppleSong` (Task 1), `CatalogSource`/`CatalogTrack` (Task 1).
- Produces: `appleCatalog(client: AppleClient, cache?: TtlCache<CatalogTrack[]>): CatalogSource`. Default cache: 500 entries, 24 h.
  - `search(query, { limit = 5 })` → `GET /search?types=songs&limit=<n>&term=<trimmed, whitespace-collapsed>`. Blank query → `[]` with no call. Cached under `search:<limit>:<lowercased term>`.
  - `lookupByIsrc(isrcs)` → `GET /songs?filter[isrc]=<≤25 comma-joined>`, deduped input, chunks in parallel. Empty → `[]`, no call. Not cached. Several songs can share an ISRC; all are returned.
  - `lookupByIds(ids)` → `GET /songs?ids=<≤300 comma-joined>`, same chunking rules. Not cached.
  - `artistTopSongs(artistId)` → `GET /artists/<encoded id>/view/top-songs?limit=20`. Cached under `top:<artistId>`.

- [ ] **Step 1: Write the failing test**

`packages/connectors/src/apple/catalog.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import search from "./__fixtures__/search.json";
import songs from "./__fixtures__/songs.json";
import topSongs from "./__fixtures__/top-songs.json";
import { appleCatalog } from "./catalog";
import type { AppleClient } from "./client";

function fakeClient(respond: (path: string, params: Record<string, string>) => unknown) {
  const get = vi.fn(async (path: string, params: Record<string, string> = {}) =>
    respond(path, params),
  );
  return { client: { get } as unknown as AppleClient, get };
}

describe("appleCatalog.search", () => {
  it("searches songs and maps results", async () => {
    const { client, get } = fakeClient(() => search);
    const tracks = await appleCatalog(client).search("  Radiohead   Weird Fishes ");
    expect(get).toHaveBeenCalledWith("/search", {
      types: "songs",
      limit: "5",
      term: "Radiohead Weird Fishes",
    });
    expect(tracks.map((t) => t.appleSongId)).toEqual(["1109715168", "813858377"]);
    expect(tracks[0]?.artistIds).toEqual([]);
  });

  it("passes a custom limit", async () => {
    const { client, get } = fakeClient(() => search);
    await appleCatalog(client).search("x", { limit: 10 });
    expect(get.mock.calls[0]?.[1]).toMatchObject({ limit: "10" });
  });

  it("returns [] when Apple finds nothing", async () => {
    const { client } = fakeClient(() => ({ results: {} }));
    await expect(appleCatalog(client).search("zzqxv")).resolves.toEqual([]);
  });

  it("returns [] for a blank query without calling Apple", async () => {
    const { client, get } = fakeClient(() => search);
    await expect(appleCatalog(client).search("   ")).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("caches by normalized term and limit", async () => {
    const { client, get } = fakeClient(() => search);
    const catalog = appleCatalog(client);
    await catalog.search("Radiohead Weird Fishes");
    await catalog.search("  radiohead  WEIRD fishes");
    expect(get).toHaveBeenCalledTimes(1);
    await catalog.search("Radiohead Weird Fishes", { limit: 10 });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("appleCatalog.lookupByIsrc", () => {
  it("dedupes and chunks ISRCs by 25", async () => {
    const { client, get } = fakeClient(() => songs);
    const isrcs = Array.from({ length: 30 }, (_, i) => `ISRC${i}`);
    const tracks = await appleCatalog(client).lookupByIsrc([...isrcs, "ISRC0"]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0]?.[0]).toBe("/songs");
    expect(get.mock.calls[0]?.[1]?.["filter[isrc]"]?.split(",")).toHaveLength(25);
    expect(get.mock.calls[1]?.[1]?.["filter[isrc]"]?.split(",")).toHaveLength(5);
    expect(tracks).toHaveLength(2); // one song per fake page
  });

  it("returns [] for no ISRCs without calling Apple", async () => {
    const { client, get } = fakeClient(() => songs);
    await expect(appleCatalog(client).lookupByIsrc([])).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("appleCatalog.lookupByIds", () => {
  it("fetches songs by id with artist ids hydrated", async () => {
    const { client, get } = fakeClient(() => songs);
    const tracks = await appleCatalog(client).lookupByIds(["1109715168"]);
    expect(get).toHaveBeenCalledWith("/songs", { ids: "1109715168" });
    expect(tracks[0]?.artistIds).toEqual(["657515"]);
  });

  it("chunks ids by 300", async () => {
    const { client, get } = fakeClient(() => ({ data: [] }));
    const ids = Array.from({ length: 301 }, (_, i) => String(i));
    await appleCatalog(client).lookupByIds(ids);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("returns [] for no ids without calling Apple", async () => {
    const { client, get } = fakeClient(() => songs);
    await expect(appleCatalog(client).lookupByIds([])).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("appleCatalog.artistTopSongs", () => {
  it("fetches and caches an artist's top songs", async () => {
    const { client, get } = fakeClient(() => topSongs);
    const catalog = appleCatalog(client);
    const tracks = await catalog.artistTopSongs("657515");
    await catalog.artistTopSongs("657515");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/artists/657515/view/top-songs", {
      limit: "20",
    });
    expect(tracks.map((t) => t.title)).toEqual(["Creep", "Let Down"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/connectors test catalog`
Expected: FAIL, `Failed to resolve import "./catalog"`.

- [ ] **Step 3: Implement**

`packages/connectors/src/apple/catalog.ts`:
```ts
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
```

- [ ] **Step 4: Run tests and lint**

Run: `pnpm --filter @tunelynk/connectors test catalog && pnpm --filter @tunelynk/connectors lint`
Expected: 11 tests PASS; lint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/apple/catalog.ts packages/connectors/src/apple/catalog.test.ts
git commit -m "feat(connectors): implement Apple catalog search, lookups, and top songs"
```

---

### Task 7: `createAppleCatalog` wiring, live smoke, env docs

**Files:**
- Create: `packages/connectors/src/apple/index.ts`
- Create: `packages/connectors/src/apple/index.test.ts`
- Create: `packages/connectors/src/apple/catalog.live.test.ts`
- Modify: `packages/connectors/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `createDeveloperToken` (Task 2), `createLimiter` (Task 3), `createAppleClient` (Task 5), `appleCatalog` (Task 6).
- Produces (the slice's public API, used by slice B's CLI and slice C's API):
  - `type AppleCatalogConfig = { teamId: string; keyId: string; privateKey: string; storefront: string; rps: number; burst: number; concurrency: number; fetch?: typeof fetch }`
  - `createAppleCatalog(config: AppleCatalogConfig): CatalogSource`. Call it **once per process**.
  - Re-exported from `@tunelynk/connectors`: `CatalogTrack`, `CatalogSource`, `AppleCatalogConfig`, `createAppleCatalog`, `AppleApiError`.

- [ ] **Step 1: Write the failing wiring test**

`packages/connectors/src/apple/index.test.ts`:
```ts
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import search from "./__fixtures__/search.json";
import { createAppleCatalog } from "./index";

const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

describe("createAppleCatalog", () => {
  it("wires token, limiter, client, and catalog", async () => {
    const fetch = vi.fn(
      async (_url: URL, _init?: RequestInit) =>
        new Response(JSON.stringify(search), { status: 200 }),
    );
    const catalog = createAppleCatalog({
      teamId: "TEAM",
      keyId: "KEY",
      privateKey,
      storefront: "gb",
      rps: 8,
      burst: 10,
      concurrency: 4,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const tracks = await catalog.search("Radiohead Weird Fishes");

    expect(tracks).toHaveLength(2);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url?.pathname).toBe("/v1/catalog/gb/search");
    expect(new Headers(init?.headers).get("Authorization")).toMatch(
      /^Bearer ey[\w-]+\.[\w-]+\.[\w-]+$/,
    );
  });

  it("is exported from the package root", async () => {
    const root = await import("../index");
    expect(root.createAppleCatalog).toBe(createAppleCatalog);
    expect(root.AppleApiError).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tunelynk/connectors test index`
Expected: FAIL, `Failed to resolve import "./index"` (or `createAppleCatalog` undefined).

- [ ] **Step 3: Implement the wiring and exports**

`packages/connectors/src/apple/index.ts`:
```ts
import type { CatalogSource } from "../types";
import { appleCatalog } from "./catalog";
import { createAppleClient } from "./client";
import { createDeveloperToken } from "./devToken";
import { createLimiter } from "./limiter";

export type AppleCatalogConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
  storefront: string;
  rps: number;
  burst: number;
  concurrency: number;
  fetch?: typeof fetch;
};

// Build once per process so every run shares one limiter and one token.
export function createAppleCatalog(config: AppleCatalogConfig): CatalogSource {
  const token = createDeveloperToken({
    teamId: config.teamId,
    keyId: config.keyId,
    privateKey: config.privateKey,
  });
  const limiter = createLimiter({
    rps: config.rps,
    burst: config.burst,
    concurrency: config.concurrency,
  });
  const client = createAppleClient({
    token,
    limiter,
    storefront: config.storefront,
    fetch: config.fetch,
  });
  return appleCatalog(client);
}

export { AppleApiError } from "./client";
```

`packages/connectors/src/index.ts` (replace the whole file):
```ts
export * from "./apple/index";
export * from "./types";
```

- [ ] **Step 4: Run the full suite, typecheck, lint**

Run: `pnpm --filter @tunelynk/connectors test && pnpm --filter @tunelynk/connectors typecheck && pnpm --filter @tunelynk/connectors lint`
Expected: all 45 tests PASS (6 + 9 + 5 + 4 + 8 + 11 + 2); typecheck and lint clean.

- [ ] **Step 5: Add the live smoke test**

`packages/connectors/src/apple/catalog.live.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createAppleCatalog } from "./index";

// Hits the real Apple Music API. Run with: pnpm --filter @tunelynk/connectors test:live
describe.skipIf(process.env.APPLE_LIVE !== "1")("Apple catalog (live)", () => {
  const catalog = createAppleCatalog({
    teamId: process.env.APPLE_TEAM_ID ?? "",
    keyId: process.env.APPLE_KEY_ID ?? "",
    privateKey: process.env.APPLE_PRIVATE_KEY ?? "",
    storefront: process.env.APPLE_STOREFRONT ?? "us",
    rps: 8,
    burst: 10,
    concurrency: 4,
  });

  it("search finds a known song with a preview", async () => {
    const [first] = await catalog.search("Radiohead Weird Fishes");
    expect(first).toMatchObject({
      appleSongId: "1109715168",
      artistName: "Radiohead",
    });
    expect(first?.previewUrl).toMatch(/^https:\/\//);
  });

  it("search handles '+' in the term", async () => {
    const tracks = await catalog.search("Frank Ocean Pink + White");
    expect(tracks[0]?.title).toBe("Pink + White");
  });

  it("lookupByIsrc returns the song", async () => {
    const tracks = await catalog.lookupByIsrc(["GBSTK0700004"]);
    expect(tracks.map((t) => t.appleSongId)).toContain("1109715168");
  });

  it("lookupByIds hydrates artist ids", async () => {
    const [track] = await catalog.lookupByIds(["1109715168"]);
    expect(track?.artistIds).toEqual(["657515"]);
  });

  it("artistTopSongs returns songs", async () => {
    const tracks = await catalog.artistTopSongs("657515");
    expect(tracks.length).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 6: Run the live smoke against Apple**

Run: `pnpm --filter @tunelynk/connectors test:live`
Expected: 5 tests PASS (needs `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` in the root `.env`). If a song id assertion fails because Apple re-catalogued it, print the result and update the expected id; do not loosen the assertion to "any result".

Then confirm the default suite still skips it: `pnpm --filter @tunelynk/connectors test`, expected 45 tests, no network.

- [ ] **Step 7: Document the env vars**

Append to `.env.example`:
```
# Apple Music developer token (MusicKit key). APPLE_PRIVATE_KEY = base64 of the .p8 file.
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=
APPLE_STOREFRONT=us
APPLE_CATALOG_RPS=8
APPLE_CATALOG_BURST=10
APPLE_CATALOG_CONCURRENCY=4
```

- [ ] **Step 8: Run the repo-wide check**

Run: `pnpm check`
Expected: typecheck, lint, lint:root, test, and test:integration pass for every package (integration tests skip if Postgres is not running; start it with `pnpm db:up` to include them).

- [ ] **Step 9: Commit**

```bash
git add packages/connectors/src .env.example
git commit -m "feat(connectors): wire createAppleCatalog and add live Apple smoke test"
```
