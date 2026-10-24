/**
 * The AI ranking contract. A ranker (an LLM agent, or the offline mock) receives the crowd, the eligible
 * candidates with their scoring inputs, and the evidence set. It returns a ranking in which every candidate
 * states the inputs it used, a rationale, the evidence ids it relied on, and the facts it claims.
 *
 * Nothing in the answer is trusted: the verifier (verifier.ts) checks it against the evidence before the
 * platform acts on it.
 */
import { z } from 'zod';

export const AiClaimSchema = z.object({
  evidenceId: z.string().min(1).max(200),
  value: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]),
});
export type AiClaim = z.infer<typeof AiClaimSchema>;

export const AiRankedCandidateSchema = z.object({
  campaignId: z.string().min(1).max(40),
  score: z.number().min(0).max(1),
  inputs: z.object({
    match: z.number().min(0).max(1),
    boost: z.number().min(1).max(3),
    performance: z.number().min(0).max(1),
  }),
  rationale: z.string().max(600),
  citations: z.array(z.string().min(1).max(200)).max(40),
  claims: z.array(AiClaimSchema).max(40),
});
export type AiRankedCandidate = z.infer<typeof AiRankedCandidateSchema>;

export const AiRankingSchema = z.object({
  ranking: z.array(AiRankedCandidateSchema).min(1).max(30),
});
export type AiRanking = z.infer<typeof AiRankingSchema>;

export interface AiRankRequest {
  screenId: string;
  at: string;
  crowd: {
    pax: number;
    medianDwellMin: number | null;
    maxDelayMin: number;
    topShares: { segment: string; share: number; evidenceId: string }[];
    flights: { flightId: string; label: string; pax: number; delayMin: number; dwellMin: number }[];
  };
  candidates: {
    campaignId: string;
    name: string;
    advertiser: string;
    match: number;
    boost: number;
    performance: number;
    triggers: string[];
    segmentWeights: Record<string, number>;
  }[];
  scoring: { audienceWeight: number; performanceWeight: number; formula: string };
  evidence: { id: string; source: string; field: string; value: string | number | boolean | null }[];
}

export interface AiRankResult {
  provider: string;
  model: string;
  latencyMs: number;
  /** The raw answer (parsed JSON), or null when the provider failed. */
  answer: unknown;
  error: string | null;
}

export interface AiRanker {
  readonly provider: string;
  readonly model: string;
  rank(request: AiRankRequest, signal: AbortSignal): Promise<AiRankResult>;
}
