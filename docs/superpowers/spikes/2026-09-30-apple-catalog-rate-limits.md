# Spike: Apple Music catalog rate limits

Issue: #7 · Date: 2026-09-30 · Script: `scripts/spikes/apple-catalog-rate-limits.ts`

## Question

Can the engine (sub-project 1) do ~50 catalog searches + 2 ISRC lookups per run with a
developer token only, and what concurrency/backoff should it use?

## Method

Storefront `us`, one developer token, requests from one IP. Workload per "run": 50
`/catalog/us/search?types=songs&limit=5` calls + 2 `/catalog/us/songs?filter[isrc]=` calls.
Phases: sequential baseline, concurrency sweep (2/4/8/16), burst at concurrency 32 until
first 429, recovery polling, then fixed-rate pacing (8/12/16/20 req/s, 60 requests each,
5 s cooldown between). 535 requests total across two runs.

## Results

| Phase | Rate | 200 | 429 | Notes |
|---|---|---|---|---|
| Sequential | ~5.5 req/s | 52 | 0 | 9.5 s for a full run; p50 ~180 ms |
| Concurrency 2 | ~11 req/s | 52 | 0 | 4.8 s |
| Concurrency 4 | ~26 req/s | 37 | 15 | first 429 at request 11 |
| Concurrency 8 | ~57 req/s | 17 | 35 | first 429 at request 7 |
| Concurrency 16 | ~114 req/s | 9 | 43 | first 429 at request 5 |
| Paced 8 req/s | 8 | 60 | 0 | |
| Paced 12 req/s | 12 | 60 | 0 | |
| Paced 16 req/s | 16 | 56 | 4 | first 429 at request 15 |
| Paced 20 req/s | 20 | 48 | 12 | first 429 at request 15 |

Findings:

- **Token bucket, ~15 burst, ~11 req/s refill.** Both paced runs over the limit fail from
  request 15 on, and the successes fit `15 + seconds × 11` (16 req/s: 56 ≈ 15 + 3.75 × 11;
  20 req/s: 48 ≈ 15 + 3 × 11).
- **429s carry no `Retry-After`** and there are no rate-limit headers at all.
- **Recovery is fast:** the first request after a burst of 429s succeeded 167 ms later.
- Latency p50 ~100–200 ms, p95 < 450 ms, independent of load.
- Not tested: whether the limit is per token or per IP, and whether there is a longer
  (per-minute/hour/day) quota on top. 535 requests in a few minutes did not reach one.

## Recommendations for the engine (#10)

- **One process-wide limiter for every catalog call**, shared across concurrent runs,
  because the budget belongs to the token, not the run: token bucket at **8 req/s, burst
  10**, max **4 in flight**. That leaves ~25% headroom under the measured refill rate.
- A full run (52 calls) then takes **~6.5 s** of catalog time, which fits the "preview within
  ~1 minute" target with room for the LLM call.
- **On 429:** retry with exponential backoff plus full jitter, base **250 ms**, cap **4 s**,
  max **4 retries**. Don't wait for `Retry-After` because Apple never sends it. After a 429,
  briefly drain the shared bucket so parallel runs back off together.
- **Cache aggressively.** Store search/ISRC resolutions (the `track_links` idea) so
  regenerates and repeat suggestions skip the API.
- **Throughput ceiling:** at 8 req/s one token supports ~9 uncached runs/minute. That's
  fine for launch. Revisit alongside #15 (queue concurrency) and #20 (abuse hardening).
  Per-user run caps matter more than raw speed.
- Make rate, burst and concurrency env-configurable (`APPLE_CATALOG_RPS`,
  `APPLE_CATALOG_BURST`, `APPLE_CATALOG_CONCURRENCY`) so we can tune in production without a
  deploy.
