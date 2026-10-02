# Slice D: Guest Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest types a prompt on the landing page and, within about 15 s, sees a grid of 20 real Apple tracks they can preview as 30 s clips. This is issue #10's done-when, in the "visual grid" design chosen in the UI spike (variant B).

**Architecture:** The React SPA in `apps/web` uses `react-router` v7 with two routes: `/` (landing) and `/playlists/:playlistId/runs/:runId` (run view).
- **`lib/api.ts`** calls `POST /api/runs` and `GET /api/runs/:id` with `fetch` and validates responses with the shared zod schemas.
- **Hooks:** `useRun` polls a run every 1 s until it finishes. `useCreateRun` submits and navigates. `usePreviewPlayer` owns one shared `<audio>`. `useElapsed` counts seconds.
- **Presentational components:** `TopBar`, `TrackGrid`/`TrackTile`, `NowPlayingBar`, `ErrorBanner`, `Shell`.
- **Deploy:** the docs gain the new env vars, and a bundle smoke test proves the SPA and API serve together.

**Tech Stack:** React 19, react-router 7.18, Tailwind CSS 4, Vite 8, Vitest 5 + Testing Library (jsdom), zod 4 contracts from `@tunelynk/shared`.

**Spec:** `docs/superpowers/specs/2026-10-01-engine-guest-generate-design.md` (sections "Web", "Error handling", "Testing → D", "Slices"). UI source: the spike prototype on branch `prototype/10-guest-ui` (`apps/web/src/prototype/VariantB.tsx`). The verdict is recorded on issue #10. Earlier plans: slices A–C in `docs/superpowers/plans/2026-10-0{1,2}-slice-*.md`.

## Global Constraints

- Branch `feat/10-slice-d-guest-web`, stacked on `feat/10-slice-c-runs-api` (PR #25).
- Node 22.23.3 (`PATH="$HOME/Library/Application Support/Herd/config/nvm/versions/node/v22.23.3/bin:$PATH"` if the shell resolves 22.19).
- `react-router@^7.18.4`, imported from `"react-router"`. The latest is v8, which is newer than the spec. Do not use v8.
- **Visual language from variant B:**
  - page `bg-zinc-950 text-white`
  - logo `tunelynk` in a `from-fuchsia-400 to-amber-300` gradient
  - rounded-full inputs (`bg-white/10`) and a white primary button
  - hero "Type a vibe. / Get a playlist." with a gradient second line
  - example chips `bg-white/10`
  - grid `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-5`
  - square art tiles with a hover overlay ▶, a `ring-4 ring-fuchsia-500` and a progress bar while playing
  - a floating now-playing bar at the bottom with progress, pause and next
- Prompt input `maxLength={PROMPT_MAX_LENGTH}` (280, UTF-16 code units, matching the API).
- Poll interval 1000 ms. Polling stops at `draft`, `published`, `failed` or `expired`, and on 404.
- Skeleton count: 20 (the guest playlist length).
- One clip at a time. The clip stops at its end. Tiles without `previewUrl` are not playable.
- User-facing create errors are exactly:
  - `invalid_prompt`: "Prompts need 1–280 characters."
  - `budget_exceeded`: "Daily generation limit reached. Try again tomorrow."
  - `run_in_progress`: "You already have a playlist generating." plus an "Open it" link to that run
  - `not_found` / unexpected: "Something went wrong. Try again."
  - network: "Couldn't reach Tunelynk. Check your connection and try again."
- Stage labels: `llm` "Asking the AI…", `matching` "Finding tracks on Apple Music…", otherwise "Starting…".
- No secrets in code or docs. Production env values are set by the user in Dokploy.
- Format with `pnpm --filter @tunelynk/web exec biome check --write .` before each commit.

## Review Focus

1. **Reloading or sharing a run URL mid-generation.** Expected: the run view picks up wherever the run is (skeletons + stage, or the finished grid). Nothing depends on navigation state. Pinned in Task 4 (RunView renders from the URL alone).
2. **The API drops for a few seconds while polling** (deploy, network blip). Expected: polling continues, a quiet "Reconnecting…" note shows, and it recovers without a reload. Pinned in Task 2.
3. **A track without a preview URL.** Expected: the tile still shows art and title but can't be played, and the now-playing "next" skips it. Pinned in Tasks 2 and 3.
4. **Leaving the run page while a clip plays** (navigating home, or starting a new prompt). Expected: the audio stops; no ghost playback. Pinned in Task 4.
5. **Double-submitting the prompt** (Enter twice, chip then Enter). Expected: the button is disabled while a request is pending, so only one POST goes out. Pinned in Task 4.

---

## File Structure

```
apps/web/
  package.json                      add react-router (modify)
  src/
    index.css                       tile-in keyframes (modify)
    App.tsx                         router (replace)
    api.ts, HealthStatus.tsx, HealthStatus.test.tsx   (delete: replaced by lib/api.ts)
    lib/
      api.ts                        createRun, fetchRun, RunNotFoundError
      api.test.ts
      format.ts                     artwork, formatTotalDuration, stageLabel, runPath
      format.test.ts
    hooks/
      useRun.ts, useRun.test.ts
      useElapsed.ts
      usePreviewPlayer.ts, usePreviewPlayer.test.ts
      useCreateRun.ts
    components/
      Shell.tsx                     page wrapper
      TopBar.tsx                    logo + prompt form
      ErrorBanner.tsx
      TrackTile.tsx, TrackGrid.tsx, NowPlayingBar.tsx
      components.test.tsx
    pages/
      Landing.tsx, Landing.test.tsx
      RunView.tsx, RunView.test.tsx
      NotFound.tsx
    test/
      setup.ts                      stub HTMLMediaElement play/pause (modify)
      fixtures.ts                   makeTrack, makeRun, ids
      fetch.ts                      stubFetch(handler)
docs/deploy.md                      env vars + ordering (modify)
```

---

### Task 1: API client, formatting helpers, test fixtures

**Files:**
- Modify: `apps/web/package.json`, `apps/web/src/test/setup.ts`, `apps/web/src/index.css`
- Create: `apps/web/src/lib/api.ts`, `apps/web/src/lib/format.ts`, `apps/web/src/test/fixtures.ts`, `apps/web/src/test/fetch.ts`
- Delete: `apps/web/src/api.ts`, `apps/web/src/HealthStatus.tsx`, `apps/web/src/HealthStatus.test.tsx`
- Modify: `apps/web/src/App.tsx` (temporary placeholder so the build stays green until Task 4)
- Test: `apps/web/src/lib/api.test.ts`, `apps/web/src/lib/format.test.ts`

**Interfaces:**
- Consumes: `CreateRunResponse`, `ApiError`, `RunResponse`, `RunTrack`, `RunStage` (`@tunelynk/shared`).
- Produces:
  - `type CreateRunResult = { ok: true; runId: string; playlistId: string } | { ok: false; error: ApiError["error"] | "network"; runId?: string; playlistId?: string }`
  - `createRun(prompt: string): Promise<CreateRunResult>`: never throws
  - `class RunNotFoundError extends Error`
  - `fetchRun(runId: string): Promise<RunResponse>`: throws `RunNotFoundError` on 404 and `Error` on other failures
  - `artwork(url: string | null, size: number): string | null`, `formatTotalDuration(tracks: RunTrack[]): string`, `stageLabel(stage: RunStage | null): string`, `runPath(playlistId: string, runId: string): string`
  - Test helpers: `IDS`, `makeTrack(n, overrides?)`, `makeRun(overrides?)`, `stubFetch(handler)`

- [ ] **Step 1: Confirm the branch and add react-router**

Run: `git branch --show-current`. The expected output is `feat/10-slice-d-guest-web`.

In `apps/web/package.json` `dependencies`, add `"react-router": "^7.18.4"` (keep keys sorted). Run `pnpm install`.
Expected: lockfile updated and `pnpm-workspace.yaml` unchanged. If pnpm adds a `minimumReleaseAgeExclude` entry, revert it and pin an older 7.x.

- [ ] **Step 2: Test infrastructure**

`apps/web/src/test/setup.ts` (replace the whole file):
```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// jsdom does not implement media playback.
beforeEach(() => {
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(
    () => {},
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
```

`apps/web/src/test/fixtures.ts`:
```ts
import type { RunResponse, RunTrack } from "@tunelynk/shared";

export const IDS = {
  run: "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1c33",
  playlist: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
  otherRun: "11111111-2222-4333-8444-555555555555",
  otherPlaylist: "66666666-7777-4888-9999-000000000000",
};

export function makeTrack(n: number, overrides: Partial<RunTrack> = {}): RunTrack {
  return {
    position: n,
    appleSongId: `song-${n}`,
    title: `Song ${n}`,
    artistName: `Artist ${n}`,
    album: `Album ${n}`,
    artworkUrl: `https://img.example/${n}/300x300bb.jpg`,
    previewUrl: `https://audio.example/${n}.m4a`,
    durationMs: 200_000,
    explicit: false,
    source: "llm",
    ...overrides,
  };
}

export function makeRun(overrides: Partial<RunResponse> = {}): RunResponse {
  return {
    id: IDS.run,
    status: "draft",
    stage: null,
    error: null,
    playlist: { id: IDS.playlist, name: "Sunday Drive", prompt: "sunday drive" },
    tracks: [makeTrack(1), makeTrack(2)],
    unmatched: [],
    ...overrides,
  };
}
```

`apps/web/src/test/fetch.ts`:
```ts
import { vi } from "vitest";

type Handler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

// Routes fetch calls to a handler; returns the mock for call assertions.
export function stubFetch(handler: Handler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
```

Append to `apps/web/src/index.css`:
```css

@keyframes tile-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

- [ ] **Step 3: Write the failing tests**

`apps/web/src/lib/api.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { stubFetch } from "../test/fetch";
import { IDS, makeRun } from "../test/fixtures";
import { createRun, fetchRun, RunNotFoundError } from "./api";

describe("createRun", () => {
  it("POSTs the prompt and returns the ids on 202", async () => {
    const fetch = stubFetch(() =>
      Response.json({ runId: IDS.run, playlistId: IDS.playlist }, { status: 202 }),
    );
    expect(await createRun("road trip")).toEqual({
      ok: true,
      runId: IDS.run,
      playlistId: IDS.playlist,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("/api/runs");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: "road trip" });
  });

  it.each([
    [400, { error: "invalid_prompt" }],
    [503, { error: "budget_exceeded" }],
    [409, { error: "run_in_progress", runId: IDS.run, playlistId: IDS.playlist }],
  ])("returns the API error for %i", async (status, body) => {
    stubFetch(() => Response.json(body, { status }));
    expect(await createRun("p")).toEqual({ ok: false, ...body });
  });

  it("reports network failures and unexpected bodies as network errors", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await createRun("p")).toEqual({ ok: false, error: "network" });
    stubFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
    expect(await createRun("p")).toEqual({ ok: false, error: "network" });
  });
});

describe("fetchRun", () => {
  it("GETs and validates the run", async () => {
    const fetch = stubFetch(() => Response.json(makeRun()));
    expect(await fetchRun(IDS.run)).toEqual(makeRun());
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`/api/runs/${IDS.run}`);
  });

  it("throws RunNotFoundError on 404", async () => {
    stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    await expect(fetchRun(IDS.run)).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("throws on other failures and on malformed bodies", async () => {
    stubFetch(() => new Response("oops", { status: 500 }));
    await expect(fetchRun(IDS.run)).rejects.toThrow("500");
    stubFetch(() => Response.json({ id: "nope" }));
    await expect(fetchRun(IDS.run)).rejects.toThrow();
  });
});
```

`apps/web/src/lib/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { makeTrack } from "../test/fixtures";
import { artwork, formatTotalDuration, runPath, stageLabel } from "./format";

describe("format helpers", () => {
  it("resizes Apple artwork URLs", () => {
    expect(artwork("https://img/a/300x300bb.jpg", 600)).toBe("https://img/a/600x600bb.jpg");
    expect(artwork(null, 600)).toBe(null);
  });

  it("formats total duration", () => {
    const tracks = (minutes: number) => [makeTrack(1, { durationMs: minutes * 60_000 })];
    expect(formatTotalDuration(tracks(42))).toBe("42 min");
    expect(formatTotalDuration(tracks(72))).toBe("1 hr 12 min");
    expect(formatTotalDuration([])).toBe("0 min");
  });

  it("labels stages", () => {
    expect(stageLabel("llm")).toBe("Asking the AI…");
    expect(stageLabel("matching")).toBe("Finding tracks on Apple Music…");
    expect(stageLabel(null)).toBe("Starting…");
    expect(stageLabel("taste")).toBe("Starting…");
  });

  it("builds run paths", () => {
    expect(runPath("p", "r")).toBe("/playlists/p/runs/r");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @tunelynk/web test lib`
Expected: FAIL with `Cannot find module './api'` / `'./format'`.

- [ ] **Step 5: Implement**

`apps/web/src/lib/api.ts`:
```ts
import { ApiError, CreateRunResponse, RunResponse } from "@tunelynk/shared";

// Same-origin: the API serves the SPA in production and Vite proxies /api in dev,
// so the guest cookie travels with every request.

export type CreateRunResult =
  | { ok: true; runId: string; playlistId: string }
  | {
      ok: false;
      error: ApiError["error"] | "network";
      runId?: string;
      playlistId?: string;
    };

export async function createRun(prompt: string): Promise<CreateRunResult> {
  let res: Response;
  try {
    res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 202) {
    const created = CreateRunResponse.safeParse(body);
    return created.success
      ? { ok: true, ...created.data }
      : { ok: false, error: "network" };
  }
  const error = ApiError.safeParse(body);
  return error.success
    ? { ok: false, ...error.data }
    : { ok: false, error: "network" };
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

export async function fetchRun(runId: string): Promise<RunResponse> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) throw new RunNotFoundError(runId);
  if (!res.ok) throw new Error(`GET /api/runs/${runId} failed with ${res.status}`);
  return RunResponse.parse(await res.json());
}
```

`apps/web/src/lib/format.ts`:
```ts
import type { RunStage, RunTrack } from "@tunelynk/shared";

// Apple artwork URLs embed their size ("…/300x300bb.jpg").
export const artwork = (url: string | null, size: number): string | null =>
  url ? url.replace("300x300", `${size}x${size}`) : null;

export function formatTotalDuration(tracks: RunTrack[]): string {
  const minutes = Math.round(
    tracks.reduce((sum, t) => sum + t.durationMs, 0) / 60_000,
  );
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
    : `${minutes} min`;
}

export function stageLabel(stage: RunStage | null): string {
  if (stage === "llm") return "Asking the AI…";
  if (stage === "matching") return "Finding tracks on Apple Music…";
  return "Starting…";
}

export const runPath = (playlistId: string, runId: string) =>
  `/playlists/${playlistId}/runs/${runId}`;
```

Delete `apps/web/src/api.ts`, `apps/web/src/HealthStatus.tsx`, and `apps/web/src/HealthStatus.test.tsx`. Their only job was the scaffold's health line; `/api/health` remains for the Dokploy health check.

`apps/web/src/App.tsx` (temporary until Task 4):
```tsx
export function App() {
  return <main className="min-h-screen bg-zinc-950 text-white" />;
}
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/web exec biome check --write . && pnpm --filter @tunelynk/web test && pnpm --filter @tunelynk/web typecheck && pnpm --filter @tunelynk/web lint`
Expected: 12 tests PASS (8 api: 1 + 3 rows + 1 createRun, 3 fetchRun; 4 format). Typecheck and lint clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add runs API client, format helpers, and test fixtures"
```

---

### Task 2: Hooks (polling, elapsed, preview player)

**Files:**
- Create: `apps/web/src/hooks/useRun.ts`, `apps/web/src/hooks/useElapsed.ts`, `apps/web/src/hooks/usePreviewPlayer.ts`
- Test: `apps/web/src/hooks/useRun.test.ts`, `apps/web/src/hooks/usePreviewPlayer.test.ts`

**Interfaces:**
- Consumes: `fetchRun`, `RunNotFoundError` (Task 1); `RunResponse`, `RunTrack` (`@tunelynk/shared`).
- Produces:
  - `POLL_MS = 1000`
  - `type RunState = { run: RunResponse | null; notFound: boolean; reconnecting: boolean }`
  - `useRun(runId: string): RunState`. Fetches immediately, then every `POLL_MS` until the status is terminal (`draft` | `published` | `failed` | `expired`) or the run 404s. A fetch failure sets `reconnecting: true` and keeps polling. Changing `runId` restarts.
  - `isRunning(state: RunState): boolean`: true while the run is not loaded yet or is queued/running (and not notFound)
  - `useElapsed(active: boolean): number`: whole seconds since `active` became true; resets on each activation
  - `type PreviewPlayer = { current: RunTrack | null; progress: number; toggle(track: RunTrack): void; stop(): void }`
  - `usePreviewPlayer(): PreviewPlayer`: one shared `Audio`. `toggle` plays a track, pauses it if it's already current, or switches to another. Tracks without `previewUrl` are ignored. The `ended` event and a rejected `play()` reset `current`. Unmount pauses.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/hooks/useRun.test.ts`:
```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../test/fetch";
import { IDS, makeRun } from "../test/fixtures";
import { isRunning, POLL_MS, useRun } from "./useRun";

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const tick = () => act(() => vi.advanceTimersByTimeAsync(POLL_MS));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useRun", () => {
  it("polls until the run reaches a terminal status", async () => {
    const statuses = [
      makeRun({ status: "running", stage: "llm", tracks: [] }),
      makeRun({ status: "running", stage: "matching", tracks: [] }),
      makeRun(),
    ];
    const fetch = stubFetch(() => Response.json(statuses.shift() ?? makeRun()));
    const { result } = renderHook(() => useRun(IDS.run));
    expect(isRunning(result.current)).toBe(true);

    await flush();
    expect(result.current.run?.stage).toBe("llm");
    await tick();
    expect(result.current.run?.stage).toBe("matching");
    await tick();
    expect(result.current.run?.status).toBe("draft");
    expect(isRunning(result.current)).toBe(false);

    await tick();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops on 404", async () => {
    const fetch = stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    const { result } = renderHook(() => useRun(IDS.run));
    await flush();
    expect(result.current.notFound).toBe(true);
    expect(isRunning(result.current)).toBe(false);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through network errors and recovers", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      if (calls === 2) throw new TypeError("Failed to fetch");
      return Response.json(
        calls < 3 ? makeRun({ status: "running", stage: "llm", tracks: [] }) : makeRun(),
      );
    });
    const { result } = renderHook(() => useRun(IDS.run));
    await flush();
    await tick();
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.run?.stage).toBe("llm");
    await tick();
    expect(result.current.reconnecting).toBe(false);
    expect(result.current.run?.status).toBe("draft");
  });

  it("restarts when the run id changes", async () => {
    const fetch = stubFetch((url) =>
      Response.json(url.endsWith(IDS.otherRun) ? makeRun({ id: IDS.otherRun }) : makeRun()),
    );
    const { result, rerender } = renderHook(({ id }) => useRun(id), {
      initialProps: { id: IDS.run },
    });
    await flush();
    rerender({ id: IDS.otherRun });
    expect(result.current.run).toBe(null);
    await flush();
    expect(result.current.run?.id).toBe(IDS.otherRun);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
```

`apps/web/src/hooks/usePreviewPlayer.test.ts`:
```ts
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeTrack } from "../test/fixtures";
import { usePreviewPlayer } from "./usePreviewPlayer";

function capturePlayer() {
  let element: HTMLMediaElement | undefined;
  const play = vi
    .spyOn(window.HTMLMediaElement.prototype, "play")
    .mockImplementation(function (this: HTMLMediaElement) {
      element = this;
      return Promise.resolve();
    });
  const pause = vi.spyOn(window.HTMLMediaElement.prototype, "pause");
  return { play, pause, element: () => element };
}

describe("usePreviewPlayer", () => {
  it("plays, pauses on a second toggle, and switches tracks", () => {
    const audio = capturePlayer();
    const { result } = renderHook(() => usePreviewPlayer());
    const [a, b] = [makeTrack(1), makeTrack(2)];

    act(() => result.current.toggle(a));
    expect(result.current.current).toBe(a);
    expect(audio.element()?.src).toBe("https://audio.example/1.m4a");

    act(() => result.current.toggle(b));
    expect(result.current.current).toBe(b);
    expect(audio.element()?.src).toBe("https://audio.example/2.m4a");

    act(() => result.current.toggle(b));
    expect(result.current.current).toBe(null);
    expect(audio.pause).toHaveBeenCalled();
  });

  it("ignores tracks without a preview", () => {
    const audio = capturePlayer();
    const { result } = renderHook(() => usePreviewPlayer());
    act(() => result.current.toggle(makeTrack(1, { previewUrl: null })));
    expect(result.current.current).toBe(null);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it("resets when the clip ends and tracks progress", () => {
    const audio = capturePlayer();
    const { result } = renderHook(() => usePreviewPlayer());
    act(() => result.current.toggle(makeTrack(1)));
    const el = audio.element();
    if (!el) throw new Error("no audio element");
    Object.defineProperty(el, "duration", { value: 30, configurable: true });
    Object.defineProperty(el, "currentTime", { value: 15, configurable: true });
    act(() => el.dispatchEvent(new Event("timeupdate")));
    expect(result.current.progress).toBe(0.5);
    act(() => el.dispatchEvent(new Event("ended")));
    expect(result.current.current).toBe(null);
    expect(result.current.progress).toBe(0);
  });

  it("resets when playback is rejected", async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(
      new Error("NotAllowedError"),
    );
    const { result } = renderHook(() => usePreviewPlayer());
    await act(async () => result.current.toggle(makeTrack(1)));
    expect(result.current.current).toBe(null);
  });

  it("stops playback on unmount", () => {
    const audio = capturePlayer();
    const { result, unmount } = renderHook(() => usePreviewPlayer());
    act(() => result.current.toggle(makeTrack(1)));
    unmount();
    expect(audio.pause).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tunelynk/web test hooks`
Expected: FAIL with `Cannot find module './useRun'` / `'./usePreviewPlayer'`.

- [ ] **Step 3: Implement**

`apps/web/src/hooks/useRun.ts`:
```ts
import type { RunResponse, RunStatus } from "@tunelynk/shared";
import { useEffect, useState } from "react";
import { fetchRun, RunNotFoundError } from "../lib/api";

export const POLL_MS = 1000;
const TERMINAL: RunStatus[] = ["draft", "published", "failed", "expired"];

export type RunState = {
  run: RunResponse | null;
  notFound: boolean;
  reconnecting: boolean;
};

const initial: RunState = { run: null, notFound: false, reconnecting: false };

export function isRunning({ run, notFound }: RunState): boolean {
  if (notFound) return false;
  return !run || run.status === "queued" || run.status === "running";
}

// Polls until the run finishes. Network errors keep polling (a deploy or a
// blip shouldn't strand the page); a 404 stops.
export function useRun(runId: string): RunState {
  const [state, setState] = useState<RunState>(initial);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(initial);

    const poll = async () => {
      try {
        const run = await fetchRun(runId);
        if (cancelled) return;
        setState({ run, notFound: false, reconnecting: false });
        if (TERMINAL.includes(run.status)) return;
      } catch (err) {
        if (cancelled) return;
        if (err instanceof RunNotFoundError) {
          setState({ run: null, notFound: true, reconnecting: false });
          return;
        }
        setState((s) => ({ ...s, reconnecting: true }));
      }
      timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId]);

  return state;
}
```

`apps/web/src/hooks/useElapsed.ts`:
```ts
import { useEffect, useState } from "react";

// Whole seconds since `active` last became true.
export function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    setSeconds(0);
    const id = setInterval(
      () => setSeconds(Math.floor((Date.now() - start) / 1000)),
      250,
    );
    return () => clearInterval(id);
  }, [active]);
  return seconds;
}
```

`apps/web/src/hooks/usePreviewPlayer.ts`:
```ts
import type { RunTrack } from "@tunelynk/shared";
import { useCallback, useEffect, useRef, useState } from "react";

export type PreviewPlayer = {
  current: RunTrack | null;
  progress: number;
  toggle(track: RunTrack): void;
  stop(): void;
};

// One shared <audio>: one 30 s clip at a time.
export function usePreviewPlayer(): PreviewPlayer {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<RunTrack | null>(null);
  const [progress, setProgress] = useState(0);

  const stop = useCallback(() => {
    audio.current?.pause();
    setCurrent(null);
    setProgress(0);
  }, []);

  useEffect(() => {
    const el = new Audio();
    audio.current = el;
    const onTime = () =>
      setProgress(el.duration ? el.currentTime / el.duration : 0);
    const onEnd = () => {
      setCurrent(null);
      setProgress(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnd);
    return () => {
      el.pause();
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnd);
      audio.current = null;
    };
  }, []);

  const toggle = useCallback(
    (track: RunTrack) => {
      const el = audio.current;
      if (!el || !track.previewUrl) return;
      if (current?.appleSongId === track.appleSongId) {
        stop();
        return;
      }
      el.src = track.previewUrl;
      setCurrent(track);
      setProgress(0);
      el.play().catch(() => {
        setCurrent((c) => (c?.appleSongId === track.appleSongId ? null : c));
      });
    },
    [current, stop],
  );

  return { current, progress, toggle, stop };
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/web exec biome check --write . && pnpm --filter @tunelynk/web test && pnpm --filter @tunelynk/web typecheck && pnpm --filter @tunelynk/web lint`
Expected: all tests PASS (Task 1's + 4 useRun + 5 player); typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks
git commit -m "feat(web): add run polling, elapsed timer, and preview player hooks"
```

---

### Task 3: Presentational components (variant B)

**Files:**
- Create: `apps/web/src/components/Shell.tsx`, `TopBar.tsx`, `ErrorBanner.tsx`, `TrackTile.tsx`, `TrackGrid.tsx`, `NowPlayingBar.tsx`
- Test: `apps/web/src/components/components.test.tsx`

**Interfaces:**
- Consumes: `PreviewPlayer` (Task 2); `artwork` (Task 1); `RunTrack`, `PROMPT_MAX_LENGTH` (`@tunelynk/shared`); `Link` (`react-router`).
- Produces:
  - `Shell({ children })`: the dark page wrapper
  - `TopBar({ initialPrompt?, busyLabel?, onSubmit(prompt: string) })`: logo link to `/`, an input labelled "Describe a playlist", and a submit button. The button reads "Generate", or `busyLabel` when set, and is disabled while busy or when the input is blank. The text resets when `initialPrompt` changes.
  - `ErrorBanner({ message, href? })`: `role="alert"`, with an "Open it" link when `href` is given
  - `TrackTile({ track, index, playing, progress, onToggle })`: a button labelled "Play {title} by {artist}" or "Pause …". It is disabled without a preview.
  - `TrackGrid({ tracks: RunTrack[] | null, player })`: 20 skeletons (`data-testid="skeleton-tile"`) when `tracks` is null
  - `NowPlayingBar({ player, tracks })`: `role="region"` labelled "Now playing". It has "Pause" and "Next track" buttons, and Next skips tracks without previews. It renders nothing when idle.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/components.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { PreviewPlayer } from "../hooks/usePreviewPlayer";
import { makeTrack } from "../test/fixtures";
import { ErrorBanner } from "./ErrorBanner";
import { NowPlayingBar } from "./NowPlayingBar";
import { TopBar } from "./TopBar";
import { TrackGrid } from "./TrackGrid";

const player = (overrides: Partial<PreviewPlayer> = {}): PreviewPlayer => ({
  current: null,
  progress: 0,
  toggle: vi.fn(),
  stop: vi.fn(),
  ...overrides,
});

const inRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("TopBar", () => {
  it("submits the trimmed prompt and disables when blank", () => {
    const onSubmit = vi.fn();
    inRouter(<TopBar onSubmit={onSubmit} />);
    const button = screen.getByRole("button", { name: "Generate" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Describe a playlist"), {
      target: { value: "  road trip  " },
    });
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith("road trip");
  });

  it("shows the busy label and blocks submits while busy", () => {
    const onSubmit = vi.fn();
    inRouter(<TopBar initialPrompt="road trip" busyLabel="7s" onSubmit={onSubmit} />);
    const button = screen.getByRole("button", { name: "7s" });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form") as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("caps input at 280 characters", () => {
    inRouter(<TopBar onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Describe a playlist")).toHaveAttribute("maxLength", "280");
  });
});

describe("ErrorBanner", () => {
  it("shows the message and an optional link", () => {
    inRouter(<ErrorBanner message="Busy." href="/playlists/p/runs/r" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Busy.");
    expect(screen.getByRole("link", { name: "Open it" })).toHaveAttribute("href", "/playlists/p/runs/r");
  });
});

describe("TrackGrid", () => {
  it("shows 20 skeletons while loading", () => {
    render(<TrackGrid tracks={null} player={player()} />);
    expect(screen.getAllByTestId("skeleton-tile")).toHaveLength(20);
  });

  it("toggles a track on click and marks the playing one", () => {
    const tracks = [makeTrack(1), makeTrack(2)];
    const p = player({ current: tracks[1] ?? null, progress: 0.5 });
    render(<TrackGrid tracks={tracks} player={p} />);
    fireEvent.click(screen.getByRole("button", { name: "Play Song 1 by Artist 1" }));
    expect(p.toggle).toHaveBeenCalledWith(tracks[0]);
    expect(screen.getByRole("button", { name: "Pause Song 2 by Artist 2" })).toHaveAttribute("aria-pressed", "true");
  });

  it("disables tracks without a preview", () => {
    render(<TrackGrid tracks={[makeTrack(1, { previewUrl: null })]} player={player()} />);
    expect(screen.getByRole("button", { name: "Play Song 1 by Artist 1" })).toBeDisabled();
  });
});

describe("NowPlayingBar", () => {
  it("renders nothing when idle", () => {
    const { container } = render(<NowPlayingBar player={player()} tracks={[makeTrack(1)]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("pauses and skips to the next playable track", () => {
    const tracks = [makeTrack(1), makeTrack(2, { previewUrl: null }), makeTrack(3)];
    const p = player({ current: tracks[0] ?? null });
    render(<NowPlayingBar player={p} tracks={tracks} />);
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("Song 1");
    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    expect(p.toggle).toHaveBeenCalledWith(tracks[2]);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(p.stop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tunelynk/web test components`
Expected: FAIL with `Cannot find module './ErrorBanner'` (and the others).

- [ ] **Step 3: Implement**

`apps/web/src/components/Shell.tsx`:
```tsx
export function Shell({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen bg-zinc-950 pb-40 text-white">{children}</main>;
}
```

`apps/web/src/components/TopBar.tsx`:
```tsx
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
```

`apps/web/src/components/ErrorBanner.tsx`:
```tsx
import { Link } from "react-router";

export function ErrorBanner({ message, href }: { message: string; href?: string }) {
  return (
    <div
      role="alert"
      className="mx-auto mt-6 flex max-w-6xl items-center gap-3 rounded-xl border border-rose-400/30 bg-rose-500/10 px-5 py-3 text-rose-100"
    >
      <span className="flex-1">{message}</span>
      {href && (
        <Link to={href} className="font-semibold underline">
          Open it
        </Link>
      )}
    </div>
  );
}
```

`apps/web/src/components/TrackTile.tsx`:
```tsx
import type { RunTrack } from "@tunelynk/shared";
import { artwork } from "../lib/format";

export function TrackTile({
  track,
  index,
  playing,
  progress,
  onToggle,
}: {
  track: RunTrack;
  index: number;
  playing: boolean;
  progress: number;
  onToggle: (track: RunTrack) => void;
}) {
  const art = artwork(track.artworkUrl, 600);
  return (
    <button
      type="button"
      onClick={() => onToggle(track)}
      disabled={!track.previewUrl}
      aria-pressed={playing}
      aria-label={`${playing ? "Pause" : "Play"} ${track.title} by ${track.artistName}`}
      className="group animate-[tile-in_0.4s_ease-out_both] text-left disabled:cursor-default"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div
        className={`relative aspect-square overflow-hidden rounded-xl bg-white/5 ${playing ? "ring-4 ring-fuchsia-500" : ""}`}
      >
        {art && (
          <img
            src={art}
            alt=""
            loading="lazy"
            className="size-full object-cover transition group-hover:scale-105"
          />
        )}
        {track.previewUrl && (
          <div
            className={`absolute inset-0 flex items-center justify-center bg-black/40 transition ${playing ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-white text-xl text-zinc-950 shadow-xl">
              {playing ? "❚❚" : "▶"}
            </span>
          </div>
        )}
        {playing && (
          <span
            className="absolute bottom-0 left-0 h-1 bg-fuchsia-500"
            style={{ width: `${progress * 100}%` }}
          />
        )}
      </div>
      <p className="mt-3 truncate font-semibold">{track.title}</p>
      <p className="truncate text-sm text-white/50">
        {track.explicit && (
          <span className="mr-1 rounded bg-white/20 px-1 text-[10px] text-white">E</span>
        )}
        {track.artistName}
      </p>
    </button>
  );
}
```

`apps/web/src/components/TrackGrid.tsx`:
```tsx
import type { RunTrack } from "@tunelynk/shared";
import type { PreviewPlayer } from "../hooks/usePreviewPlayer";
import { TrackTile } from "./TrackTile";

const SKELETON_KEYS = Array.from({ length: 20 }, (_, i) => `skeleton-${i}`);

export function TrackGrid({
  tracks,
  player,
}: {
  tracks: RunTrack[] | null;
  player: PreviewPlayer;
}) {
  return (
    <div
      aria-busy={tracks === null}
      className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5"
    >
      {tracks === null
        ? SKELETON_KEYS.map((key, i) => (
            <div key={key} data-testid="skeleton-tile">
              <div
                className="aspect-square animate-pulse rounded-xl bg-white/10"
                style={{ animationDelay: `${i * 60}ms` }}
              />
              <div className="mt-3 h-3 w-3/4 rounded bg-white/10" />
              <div className="mt-2 h-3 w-1/2 rounded bg-white/5" />
            </div>
          ))
        : tracks.map((track, i) => {
            const playing = player.current?.appleSongId === track.appleSongId;
            return (
              <TrackTile
                key={track.appleSongId}
                track={track}
                index={i}
                playing={playing}
                progress={playing ? player.progress : 0}
                onToggle={player.toggle}
              />
            );
          })}
    </div>
  );
}
```

`apps/web/src/components/NowPlayingBar.tsx`:
```tsx
import type { RunTrack } from "@tunelynk/shared";
import type { PreviewPlayer } from "../hooks/usePreviewPlayer";

export function NowPlayingBar({
  player,
  tracks,
}: {
  player: PreviewPlayer;
  tracks: RunTrack[];
}) {
  const track = player.current;
  if (!track) return null;
  const playable = tracks.filter((t) => t.previewUrl);
  const index = playable.findIndex((t) => t.appleSongId === track.appleSongId);
  const next = playable[(index + 1) % playable.length];

  return (
    <section
      aria-label="Now playing"
      className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-3xl items-center gap-4 rounded-2xl border border-white/10 bg-zinc-900/95 p-3 text-white shadow-2xl backdrop-blur"
    >
      {track.artworkUrl && (
        <img src={track.artworkUrl} alt="" className="size-12 rounded-lg" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{track.title}</p>
        <p className="truncate text-sm text-white/50">
          {track.artistName} · 30s preview
        </p>
        <div className="mt-1.5 h-1 rounded bg-white/10">
          <div
            className="h-1 rounded bg-fuchsia-500"
            style={{ width: `${player.progress * 100}%` }}
          />
        </div>
      </div>
      <button
        type="button"
        aria-label="Pause"
        onClick={player.stop}
        className="flex size-10 items-center justify-center rounded-full bg-white text-zinc-950"
      >
        ❚❚
      </button>
      {next && next.appleSongId !== track.appleSongId && (
        <button
          type="button"
          aria-label="Next track"
          onClick={() => player.toggle(next)}
          className="px-2 text-white/70 hover:text-white"
        >
          ⏭
        </button>
      )}
    </section>
  );
}
```

A `<section>` with `aria-label` has the implicit role `region`, which is what the test queries.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/web exec biome check --write . && pnpm --filter @tunelynk/web test && pnpm --filter @tunelynk/web typecheck && pnpm --filter @tunelynk/web lint`
Expected: all tests PASS (+9 component tests); typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components
git commit -m "feat(web): add variant-B top bar, track grid, and now-playing bar"
```

---

### Task 4: Pages and routing

**Files:**
- Create: `apps/web/src/hooks/useCreateRun.ts`, `apps/web/src/pages/Landing.tsx`, `apps/web/src/pages/RunView.tsx`, `apps/web/src/pages/NotFound.tsx`
- Replace: `apps/web/src/App.tsx`
- Test: `apps/web/src/pages/Landing.test.tsx`, `apps/web/src/pages/RunView.test.tsx`

**Interfaces:**
- Consumes: `createRun`, `CreateRunResult` (Task 1); `runPath`, `stageLabel`, `formatTotalDuration` (Task 1); `useRun`, `isRunning`, `useElapsed`, `usePreviewPlayer` (Task 2); all components (Task 3); `useNavigate`, `useParams`, `Link`, `BrowserRouter`, `Routes`, `Route` (`react-router`).
- Produces:
  - `useCreateRun(): { submit(prompt: string): Promise<void>; pending: boolean; error: { message: string; href?: string } | null }`. On success it navigates to `runPath(playlistId, runId)`. A second `submit` while pending does nothing.
  - `CREATE_ERRORS` with the exact copy from Global Constraints
  - Routes: `/` → `Landing`, `/playlists/:playlistId/runs/:runId` → `RunView`, `*` → `NotFound`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/pages/Landing.test.tsx`:
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { stubFetch } from "../test/fetch";
import { IDS } from "../test/fixtures";
import { Landing } from "./Landing";

function Where() {
  return <p>at {useLocation().pathname}</p>;
}

const renderLanding = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/playlists/:playlistId/runs/:runId" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Describe a playlist"), { target: { value } });

describe("Landing", () => {
  it("shows the hero and example chips", () => {
    stubFetch(() => Response.json({}));
    renderLanding();
    expect(screen.getByText("Get a playlist.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "upbeat 90s road trip" })).toBeInTheDocument();
  });

  it("creates a run and navigates to it", async () => {
    const fetch = stubFetch(() =>
      Response.json({ runId: IDS.run, playlistId: IDS.playlist }, { status: 202 }),
    );
    renderLanding();
    type("sunday drive");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByText(`at /playlists/${IDS.playlist}/runs/${IDS.run}`)).toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ prompt: "sunday drive" });
  });

  it("submits an example chip", async () => {
    const fetch = stubFetch(() =>
      Response.json({ runId: IDS.run, playlistId: IDS.playlist }, { status: 202 }),
    );
    renderLanding();
    fireEvent.click(screen.getByRole("button", { name: "rainy sunday morning jazz" }));
    await screen.findByText(/^at \/playlists/);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      prompt: "rainy sunday morning jazz",
    });
  });

  it("sends one request when submitted twice quickly", async () => {
    let release: (r: Response) => void = () => {};
    const fetch = stubFetch(() => new Promise<Response>((r) => (release = r)));
    renderLanding();
    type("p");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.click(screen.getByRole("button", { name: "upbeat 90s road trip" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    release(Response.json({ runId: IDS.run, playlistId: IDS.playlist }, { status: 202 }));
    await screen.findByText(/^at \/playlists/);
  });

  it.each([
    [503, { error: "budget_exceeded" }, "Daily generation limit reached. Try again tomorrow."],
    [400, { error: "invalid_prompt" }, "Prompts need 1–280 characters."],
  ])("shows the %i message", async (status, body, message) => {
    stubFetch(() => Response.json(body, { status }));
    renderLanding();
    type("p");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("links to the run already in progress on 409", async () => {
    stubFetch(() =>
      Response.json(
        { error: "run_in_progress", runId: IDS.run, playlistId: IDS.playlist },
        { status: 409 },
      ),
    );
    renderLanding();
    type("p");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a playlist generating.");
    expect(screen.getByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      `/playlists/${IDS.playlist}/runs/${IDS.run}`,
    );
  });

  it("explains network failures", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    renderLanding();
    type("p");
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach Tunelynk.");
  });
});
```

`apps/web/src/pages/RunView.test.tsx`:
```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { RunResponse } from "@tunelynk/shared";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS } from "../hooks/useRun";
import { stubFetch } from "../test/fetch";
import { IDS, makeRun, makeTrack } from "../test/fixtures";
import { Landing } from "./Landing";
import { RunView } from "./RunView";

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const tick = () => act(() => vi.advanceTimersByTimeAsync(POLL_MS));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/playlists/:playlistId/runs/:runId" element={<RunView />} />
      </Routes>
    </MemoryRouter>,
  );
}

const runUrl = (runId = IDS.run, playlistId = IDS.playlist) =>
  `/playlists/${playlistId}/runs/${runId}`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RunView", () => {
  it("shows skeletons and the stage while running, then the grid", async () => {
    const runs: RunResponse[] = [
      makeRun({ status: "running", stage: "llm", tracks: [] }),
      makeRun({ unmatched: [{ title: "Gone", artist: "Nobody" }] }),
    ];
    stubFetch(() => Response.json(runs.shift() ?? makeRun()));
    renderAt(runUrl());
    await flush();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Asking the AI…");
    expect(screen.getAllByTestId("skeleton-tile")).toHaveLength(20);
    expect(screen.getByLabelText("Describe a playlist")).toHaveValue("sunday drive");

    await tick();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sunday Drive");
    expect(screen.queryAllByTestId("skeleton-tile")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Play Song 1 by Artist 1" })).toBeInTheDocument();
    expect(screen.getByText(/Gone \(Nobody\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to keep" })).toBeDisabled();
  });

  it("plays a clip and shows the now-playing bar", async () => {
    stubFetch(() => Response.json(makeRun()));
    renderAt(runUrl());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Play Song 2 by Artist 2" }));
    expect(screen.getByRole("region", { name: "Now playing" })).toHaveTextContent("Song 2");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.queryByRole("region", { name: "Now playing" })).toBe(null);
  });

  it("stops the clip when leaving the run page", async () => {
    stubFetch(() => Response.json(makeRun()));
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, "pause");
    renderAt(runUrl());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Play Song 1 by Artist 1" }));
    pause.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "tunelynk" }));
    await flush();
    expect(screen.getByText("Get a playlist.")).toBeInTheDocument();
    expect(pause).toHaveBeenCalled();
  });

  it("shows the failure and retries the same prompt", async () => {
    const fetch = stubFetch((url, init) => {
      if (init?.method === "POST") {
        return Response.json({ runId: IDS.otherRun, playlistId: IDS.otherPlaylist }, { status: 202 });
      }
      return Response.json(
        url.endsWith(IDS.otherRun)
          ? makeRun({ id: IDS.otherRun, status: "running", stage: "llm", tracks: [] })
          : makeRun({ status: "failed", error: "That doesn't look like a playlist request.", tracks: [] }),
      );
    });
    renderAt(runUrl());
    await flush();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "That doesn't look like a playlist request.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flush();
    await flush();
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ prompt: "sunday drive" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Asking the AI…");
  });

  it("shows a quiet reconnecting note while the API is unreachable", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      if (calls === 2) throw new TypeError("Failed to fetch");
      return Response.json(makeRun({ status: "running", stage: "matching", tracks: [] }));
    });
    renderAt(runUrl());
    await flush();
    await tick();
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    await tick();
    expect(screen.queryByText("Reconnecting…")).toBe(null);
  });

  it("handles a run that does not exist", async () => {
    stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    renderAt(runUrl());
    await flush();
    expect(screen.getByText("This playlist doesn't exist.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start a new one" })).toHaveAttribute("href", "/");
  });

  it("disables tiles without a preview", async () => {
    stubFetch(() => Response.json(makeRun({ tracks: [makeTrack(1, { previewUrl: null })] })));
    renderAt(runUrl());
    await flush();
    expect(screen.getByRole("button", { name: "Play Song 1 by Artist 1" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @tunelynk/web test pages`
Expected: FAIL with `Cannot find module './Landing'` / `'./RunView'`.

- [ ] **Step 3: Implement**

`apps/web/src/hooks/useCreateRun.ts`:
```ts
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type CreateRunResult, createRun } from "../lib/api";
import { runPath } from "../lib/format";

export const CREATE_ERRORS = {
  invalid_prompt: "Prompts need 1–280 characters.",
  budget_exceeded: "Daily generation limit reached. Try again tomorrow.",
  run_in_progress: "You already have a playlist generating.",
  not_found: "Something went wrong. Try again.",
  network: "Couldn't reach Tunelynk. Check your connection and try again.",
} as const;

export type CreateError = { message: string; href?: string };

function toError(result: Extract<CreateRunResult, { ok: false }>): CreateError {
  const message = CREATE_ERRORS[result.error];
  return result.error === "run_in_progress" && result.runId && result.playlistId
    ? { message, href: runPath(result.playlistId, result.runId) }
    : { message };
}

export function useCreateRun() {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CreateError | null>(null);
  // A ref, not state: two clicks in one tick must still send one request.
  const inFlight = useRef(false);

  const submit = useCallback(
    async (prompt: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setError(null);
      const result = await createRun(prompt);
      inFlight.current = false;
      setPending(false);
      if (result.ok) {
        navigate(runPath(result.playlistId, result.runId));
        return;
      }
      setError(toError(result));
    },
    [navigate],
  );

  return { submit, pending, error };
}
```

`apps/web/src/pages/Landing.tsx`:
```tsx
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
          Real tracks from Apple Music, with 30-second previews. No account needed.
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
```

`apps/web/src/pages/RunView.tsx`:
```tsx
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { ErrorBanner } from "../components/ErrorBanner";
import { NowPlayingBar } from "../components/NowPlayingBar";
import { Shell } from "../components/Shell";
import { TopBar } from "../components/TopBar";
import { TrackGrid } from "../components/TrackGrid";
import { useCreateRun } from "../hooks/useCreateRun";
import { useElapsed } from "../hooks/useElapsed";
import { usePreviewPlayer } from "../hooks/usePreviewPlayer";
import { isRunning, useRun } from "../hooks/useRun";
import { formatTotalDuration, stageLabel } from "../lib/format";

export function RunView() {
  const { runId = "" } = useParams();
  const state = useRun(runId);
  const { run, notFound, reconnecting } = state;
  const running = isRunning(state);
  const elapsed = useElapsed(running);
  const player = usePreviewPlayer();
  const create = useCreateRun();

  // A new run (retry, new prompt) must not keep playing the old clip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId is the trigger
  useEffect(() => player.stop(), [runId, player.stop]);

  const busyLabel = create.pending ? "Starting…" : running ? `${elapsed}s` : undefined;
  const topBar = (
    <TopBar
      initialPrompt={run?.playlist.prompt ?? ""}
      busyLabel={busyLabel}
      onSubmit={create.submit}
    />
  );

  if (notFound) {
    return (
      <Shell>
        {topBar}
        <section className="py-24 text-center">
          <p className="text-2xl font-bold">This playlist doesn't exist.</p>
          <Link to="/" className="mt-3 inline-block text-white/60 underline">
            Start a new one
          </Link>
        </section>
      </Shell>
    );
  }

  const failed = run?.status === "failed";
  const finished = run && !running && !failed;
  const tracks = finished ? run.tracks : null;

  return (
    <Shell>
      {topBar}
      {create.error && <ErrorBanner {...create.error} />}
      <section className="mx-auto max-w-6xl px-6 pt-10">
        <div className="mb-8 flex items-end justify-between gap-6">
          <div className="min-w-0">
            {run && <p className="truncate text-sm text-white/50">“{run.playlist.prompt}”</p>}
            <h1 className="mt-1 text-4xl font-black">
              {failed ? (
                run.error
              ) : finished ? (
                run.playlist.name
              ) : (
                <span className="animate-pulse text-white/40">{stageLabel(run?.stage ?? null)}</span>
              )}
            </h1>
            {finished && (
              <p className="mt-1 text-sm text-white/50">
                {run.tracks.length} tracks · {formatTotalDuration(run.tracks)}
              </p>
            )}
            {reconnecting && running && <p className="mt-1 text-sm text-amber-300/80">Reconnecting…</p>}
          </div>
          {finished && (
            <button
              type="button"
              disabled
              title="Accounts are coming soon"
              className="shrink-0 rounded-full border border-white/30 px-5 py-2.5 text-sm opacity-50"
            >
              Sign in to keep
            </button>
          )}
        </div>

        {failed ? (
          <button
            type="button"
            disabled={create.pending}
            onClick={() => create.submit(run.playlist.prompt)}
            className="rounded-full bg-white px-5 py-2.5 font-semibold text-zinc-950 disabled:opacity-40"
          >
            Try again
          </button>
        ) : (
          <TrackGrid tracks={tracks} player={player} />
        )}

        {finished && run.unmatched.length > 0 && (
          <p className="mt-10 text-sm text-white/40">
            Couldn't find on Apple Music:{" "}
            {run.unmatched.map((u) => `${u.title} (${u.artist})`).join(", ")}
          </p>
        )}
      </section>
      <NowPlayingBar player={player} tracks={run?.tracks ?? []} />
    </Shell>
  );
}
```

`apps/web/src/pages/NotFound.tsx`:
```tsx
import { Link } from "react-router";
import { Shell } from "../components/Shell";

export function NotFound() {
  return (
    <Shell>
      <section className="py-24 text-center">
        <p className="text-2xl font-bold">Page not found.</p>
        <Link to="/" className="mt-3 inline-block text-white/60 underline">
          Go home
        </Link>
      </section>
    </Shell>
  );
}
```

`apps/web/src/App.tsx` (replace the whole file):
```tsx
import { BrowserRouter, Route, Routes } from "react-router";
import { Landing } from "./pages/Landing";
import { NotFound } from "./pages/NotFound";
import { RunView } from "./pages/RunView";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/playlists/:playlistId/runs/:runId" element={<RunView />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm --filter @tunelynk/web exec biome check --write . && pnpm --filter @tunelynk/web test && pnpm --filter @tunelynk/web typecheck && pnpm --filter @tunelynk/web lint`
Expected: all web tests PASS (+8 Landing incl. 2 rows, +7 RunView); typecheck and lint clean.
- If the `useEffect(() => player.stop(), …)` line returns a value React treats as a cleanup function, write it as `useEffect(() => { player.stop(); }, …)`. `stop` returns `undefined`, so this only matters if the types complain.
- If a fake-timer test needs one more `flush()` for a chained promise (fetch → json → setState), add it and ledger it as test-only.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add landing and run view pages with polling and previews"
```

---

### Task 5: Deploy docs and end-to-end check

**Files:**
- Modify: `docs/deploy.md`

**Interfaces:**
- Consumes: everything above; the built bundle.
- Produces: deploy documentation for the new env vars, and evidence that the built app serves the SPA, the deep-link fallback and the API together.

- [ ] **Step 1: Document the environment**

In `docs/deploy.md`, replace the env block under "One-time setup → 3. Environment" with:
````markdown
3. **Environment.**
   ```
   DATABASE_URL=<internal Postgres URL from step 1>
   PORT=3000
   APPLE_TEAM_ID=<Apple developer team id>
   APPLE_KEY_ID=<MusicKit key id>
   APPLE_PRIVATE_KEY=<base64 of the MusicKit .p8 file>
   SESSION_SECRET=<32+ random chars: openssl rand -base64 48>
   LLM_PROVIDER=anthropic
   ANTHROPIC_API_KEY=<key with credit>
   ```
   Optional, with defaults: `LLM_MODEL_GUEST` (`claude-haiku-4-5`; `gpt-4.1-mini` for openai), `LLM_MAX_TOKENS` (2000), `LLM_DAILY_BUDGET_USD` (2), `APPLE_STOREFRONT` (`us`), `APPLE_CATALOG_RPS` / `_BURST` / `_CONCURRENCY` (8 / 10 / 4). Leave `COOKIE_SECURE` unset; it defaults to `true`, which is right behind HTTPS.

   **Set these before a deploy that includes the runs API.** The server validates them at boot and exits if any are missing. The new container then never becomes healthy and the old one keeps serving, but the deploy fails. `migrate.js` needs only `DATABASE_URL`.

   No `NODE_ENV` is needed; the app does not read it. (The Dockerfile forces `NODE_ENV=development` for `pnpm install`, so the build is safe even if one is set.)
````

Replace step 6 with:
```markdown
6. Deploy. Check that https://tunelynk.bytmoor.com/api/health returns `{"ok":true,"db":"up"}`, then generate a playlist from the landing page.
```

Under "Operations", add:
```markdown
- **LLM spend:** every run records its cost in `llm_usage`. New runs are refused with `503 budget_exceeded` once today's (UTC) spend plus a reservation for in-flight runs reaches `LLM_DAILY_BUDGET_USD`.
- **Stuck runs:** a sweeper fails `queued`/`running` runs older than 3 minutes at boot and every minute, so a redeploy mid-run never strands a guest.
```

- [ ] **Step 2: Repo-wide check**

Run: `pnpm check`
Expected: all turbo tasks succeed.

- [ ] **Step 3: Built bundle smoke (no LLM cost)**

Run:
```bash
pnpm build
PORT=3999 node --env-file=.env apps/api/dist/index.js &
sleep 3
curl -s localhost:3999/ | grep -o '<div id="root"></div>'
curl -s localhost:3999/playlists/x/runs/y | grep -o '<div id="root"></div>'
curl -s -o /dev/null -w "%{http_code}\n" localhost:3999/api/runs/00000000-0000-4000-8000-000000000000
kill %1
```
Expected: `<div id="root"></div>` twice (the SPA, plus the deep-link fallback), then `404`.

- [ ] **Step 4: Browser check (manual, user; one run is about $0.004)**

Ask the user to run `pnpm dev` and open http://localhost:5173:
- Type a prompt or click a chip. The URL becomes `/playlists/…/runs/…`, skeletons show "Asking the AI…" then "Finding tracks on Apple Music…", and the art grid fills in within about 15 s.
- Click a tile: the clip plays, the tile shows the ring and progress, and the now-playing bar appears. ⏭ skips; ❚❚ stops.
- Reload the run URL: the finished grid comes back.

Record what the user reports in the ledger. Fix any bug they find test-first before finishing.

- [ ] **Step 5: Commit**

```bash
git add docs/deploy.md
git commit -m "docs: document runs API env vars and deploy ordering"
```
