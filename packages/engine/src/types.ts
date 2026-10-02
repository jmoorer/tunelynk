import type { CatalogTrack } from "@tunelynk/connectors";
import type { LlmUsage } from "./llm/types";

export type Stage = "llm" | "matching";

export type ExcludedTrack = Pick<
  CatalogTrack,
  "appleSongId" | "isrc" | "title" | "artistName"
>;

export type GenerateInput = {
  prompt: string;
  length: number;
  exclude?: ExcludedTrack[];
};

export type GeneratedTrack = CatalogTrack & { source: "llm" | "backfill" };

export type CandidateStatus = "matched" | "unmatched" | "duplicate" | "error";

export type CandidateResult = {
  title: string;
  artist: string;
  status: CandidateStatus;
  appleSongId?: string;
};

export type GenerateResult = {
  name: string;
  tracks: GeneratedTrack[];
  candidates: CandidateResult[];
  usage: LlmUsage;
};
