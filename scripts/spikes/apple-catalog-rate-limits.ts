// Spike #7: measure Apple Music catalog API rate limits with a developer token.
//
// Usage (Node >= 22.18, type stripping on by default):
//   node --env-file=.env scripts/spikes/apple-catalog-rate-limits.ts [--out results.json]
//
// Env: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (MusicKit .p8 as base64; raw PEM also accepted).
// Optional: APPLE_STOREFRONT (default "us"), SPIKE_BURST_CAP (default 400),
//   SPIKE_ONLY=paced to run only the fixed-rate phase.

import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { writeFileSync } from "node:fs";

const BASE = "https://api.music.apple.com/v1";
const storefront = process.env.APPLE_STOREFRONT ?? "us";
const burstCap = Number(process.env.SPIKE_BURST_CAP ?? 400);
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx > -1 ? process.argv[outIdx + 1] : undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

// Accepts base64 of the whole .p8 PEM, a bare base64 PKCS#8 DER body, or raw PEM.
function loadPrivateKey(raw: string): KeyObject {
  if (raw.includes("BEGIN PRIVATE KEY")) return createPrivateKey(raw.replace(/\\n/g, "\n"));
  const decoded = Buffer.from(raw.trim(), "base64");
  const text = decoded.toString("utf8");
  if (text.includes("BEGIN PRIVATE KEY")) return createPrivateKey(text);
  return createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
}

function mintDeveloperToken(): string {
  const teamId = requireEnv("APPLE_TEAM_ID");
  const keyId = requireEnv("APPLE_KEY_ID");
  const key = loadPrivateKey(requireEnv("APPLE_PRIVATE_KEY"));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: now, exp: now + 60 * 60 }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${b64url(signature)}`;
}

const token = mintDeveloperToken();

// Realistic LLM-style suggestions: "artist - title" queries.
const QUERIES = [
  "Radiohead Weird Fishes",
  "Bon Iver Holocene",
  "Frank Ocean Pink + White",
  "Tame Impala Let It Happen",
  "Phoebe Bridgers Motion Sickness",
  "Khruangbin Maria También",
  "SZA Good Days",
  "The National Bloodbuzz Ohio",
  "Mitski Nobody",
  "Kendrick Lamar Alright",
  "Fleetwood Mac Dreams",
  "Daft Punk Digital Love",
  "Beach House Space Song",
  "Arctic Monkeys Do I Wanna Know",
  "Solange Cranes in the Sky",
  "Sufjan Stevens Chicago",
  "Tyler The Creator See You Again",
  "Big Thief Not",
  "Mac DeMarco Chamber of Reflection",
  "LCD Soundsystem All My Friends",
  "Clairo Bags",
  "Steve Lacy Dark Red",
  "Japanese Breakfast Be Sweet",
  "Vampire Weekend Harmony Hall",
  "The Strokes Last Nite",
  "Childish Gambino Redbone",
  "Mazzy Star Fade Into You",
  "Cocteau Twins Heaven or Las Vegas",
  "Kali Uchis After the Storm",
  "boygenius Not Strong Enough",
  "Men I Trust Show Me How",
  "Talking Heads This Must Be the Place",
  "Blood Orange Champagne Coast",
  "Wet Leg Chaise Longue",
  "Alvvays Archie Marry Me",
  "Jai Paul Jasmine",
  "Portishead Glory Box",
  "Massive Attack Teardrop",
  "Caribou Can't Do Without You",
  "Four Tet Baby",
  "Jamie xx Gosh",
  "Rosalía Malamente",
  "Bad Bunny Tití Me Preguntó",
  "Fred again.. Delilah",
  "The xx Intro",
  "Slowdive Alison",
  "Men at Work Down Under",
  "Angel Olsen Shut Up Kiss Me",
  "Weyes Blood Andromeda",
  "Nick Drake Pink Moon",
];
const ISRCS = ["GBAYE0601498", "USUM71703861"];

type Sample = { ms: number; status: number; retryAfter?: string; phase: string };
const samples: Sample[] = [];
const seenHeaders = new Set<string>();

async function call(path: string, phase: string): Promise<Sample> {
  const start = performance.now();
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  await res.arrayBuffer();
  for (const [k] of res.headers) seenHeaders.add(k);
  const sample: Sample = {
    ms: Math.round(performance.now() - start),
    status: res.status,
    retryAfter: res.headers.get("retry-after") ?? undefined,
    phase,
  };
  samples.push(sample);
  return sample;
}

function runPaths(): string[] {
  const search = QUERIES.map(
    (q) => `/catalog/${storefront}/search?types=songs&limit=5&term=${encodeURIComponent(q)}`,
  );
  const isrc = ISRCS.map((i) => `/catalog/${storefront}/songs?filter[isrc]=${i}`);
  return [...search, ...isrc];
}

async function pool(
  paths: string[],
  concurrency: number,
  phase: string,
  stopOn429 = false,
): Promise<{ wallMs: number; first429At?: number }> {
  let next = 0;
  let first429At: number | undefined;
  const start = performance.now();
  async function worker() {
    while (next < paths.length && !(stopOn429 && first429At !== undefined)) {
      const i = next++;
      const s = await call(paths[i], phase);
      if (s.status === 429 && first429At === undefined) first429At = i;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { wallMs: Math.round(performance.now() - start), first429At };
}

function stats(phase: string) {
  const xs = samples.filter((s) => s.phase === phase);
  const ms = xs.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
  const statuses: Record<number, number> = {};
  for (const s of xs) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  return { n: xs.length, p50: pct(50), p95: pct(95), max: ms.at(-1), statuses };
}

const report: Record<string, unknown> = { storefront, startedAt: new Date().toISOString() };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fire requests at a fixed rate (not bounded by concurrency) to find the sustained limit.
async function paced(rps: number, count: number, phase: string) {
  const paths = runPaths();
  const inflight: Promise<Sample>[] = [];
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const due = start + (i * 1000) / rps;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    inflight.push(call(paths[i % paths.length], phase));
  }
  const results = await Promise.all(inflight);
  const first429At = results.findIndex((s) => s.status === 429);
  return { ...stats(phase), first429At: first429At === -1 ? undefined : first429At };
}

// Phase 1: sanity + baseline, sequential.
const probe = await call(runPaths()[0], "probe");
if (probe.status !== 200) {
  throw new Error(`Probe failed with HTTP ${probe.status}; check token/env before continuing.`);
}
if (process.env.SPIKE_ONLY !== "paced") {
const base = await pool(runPaths(), 1, "baseline");
report.baseline = { ...stats("baseline"), wallMs: base.wallMs };
console.log("baseline", report.baseline);

// Phase 2: concurrency sweep, one run's worth each.
const sweep: Record<string, unknown> = {};
for (const c of [2, 4, 8, 16]) {
  const phase = `c${c}`;
  const r = await pool(runPaths(), c, phase);
  sweep[phase] = { ...stats(phase), wallMs: r.wallMs, first429At: r.first429At };
  console.log(phase, sweep[phase]);
}
report.sweep = sweep;

// Phase 3: burst until first 429 (or cap).
const burstPaths = Array.from({ length: burstCap }, (_, i) => runPaths()[i % 52]);
const burst = await pool(burstPaths, 32, "burst", true);
report.burst = { ...stats("burst"), wallMs: burst.wallMs, first429At: burst.first429At };
console.log("burst", report.burst);

// Phase 4: recovery after a 429, polling once per second for up to 120s.
if (burst.first429At !== undefined) {
  const t0 = performance.now();
  let recoveredMs: number | undefined;
  while (performance.now() - t0 < 120_000) {
    const s = await call(runPaths()[0], "recovery");
    if (s.status === 200) {
      recoveredMs = Math.round(performance.now() - t0);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  report.recovery = { recoveredMs, retryAfterValues: [...new Set(samples.map((s) => s.retryAfter).filter(Boolean))] };
  console.log("recovery", report.recovery);
}

}

// Phase 5: fixed-rate pacing with a cooldown between rates.
const pacedReport: Record<string, unknown> = {};
for (const rps of [8, 12, 16, 20]) {
  await sleep(5000);
  pacedReport[`${rps}rps`] = await paced(rps, 60, `paced${rps}`);
  console.log(`paced ${rps}rps`, pacedReport[`${rps}rps`]);
}
report.paced = pacedReport;

report.responseHeaders = [...seenHeaders].sort();
report.totalRequests = samples.length;
console.log("headers seen", report.responseHeaders);
console.log("total requests", samples.length);
if (outPath) writeFileSync(outPath, JSON.stringify({ report, samples }, null, 2));
