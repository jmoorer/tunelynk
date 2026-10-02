// Usage: pnpm --filter @tunelynk/engine generate "<prompt>" [--length 20]
// Calls Apple and the configured LLM for real (costs money).
import { createAppleCatalog } from "@tunelynk/connectors";
import { EngineError } from "../errors";
import { generate } from "../generate";
import { createLlmProvider } from "../llm/index";
import { costMicros } from "../llm/pricing";
import type { LlmUsage } from "../llm/types";
import { loadCliConfig } from "./config";

const args = process.argv.slice(2);
const lengthAt = args.indexOf("--length");
const length = lengthAt >= 0 ? Number(args[lengthAt + 1]) : 20;
const prompt = args
  .filter((_, i) => lengthAt < 0 || (i !== lengthAt && i !== lengthAt + 1))
  .join(" ")
  .trim();

if (!prompt || !Number.isInteger(length) || length < 1) {
  console.error(
    'Usage: pnpm --filter @tunelynk/engine generate "<prompt>" [--length 20]',
  );
  process.exit(1);
}

const config = loadCliConfig(process.env);
const catalog = createAppleCatalog(config.apple);
const llm = createLlmProvider(config.llm);

const seconds = (from: number) => ((Date.now() - from) / 1000).toFixed(1);
const printUsage = (usage: LlmUsage) => {
  const dollars = costMicros(usage) / 1_000_000;
  console.log(
    `${usage.model}: ${usage.inputTokens} in / ${usage.outputTokens} out tokens, $${dollars.toFixed(4)}`,
  );
};

const started = Date.now();
try {
  const result = await generate({ prompt, length }, { catalog, llm }, (stage) =>
    console.error(`… ${stage} (${seconds(started)}s)`),
  );
  console.log(`\n${result.name}\n`);
  result.tracks.forEach((t, i) => {
    const tags = [
      t.source === "backfill" ? "backfill" : "",
      t.previewUrl ? "" : "no preview",
    ].filter(Boolean);
    const suffix = tags.length > 0 ? `  [${tags.join(", ")}]` : "";
    console.log(
      `${String(i + 1).padStart(2)}. ${t.title} — ${t.artistName}${suffix}`,
    );
  });
  const unused = result.candidates.filter((c) => c.status !== "matched");
  if (unused.length > 0) {
    console.log(`\nNot used (${unused.length}):`);
    for (const c of unused)
      console.log(`  ${c.status.padEnd(9)} ${c.title} — ${c.artist}`);
  }
  console.log(
    `\n${result.tracks.length}/${length} tracks in ${seconds(started)}s`,
  );
  printUsage(result.usage);
} catch (err) {
  if (!(err instanceof EngineError)) throw err;
  console.error(`\n${err.name}: ${err.message} (${seconds(started)}s)`);
  if (err.usage) printUsage(err.usage);
  process.exitCode = 1;
}
