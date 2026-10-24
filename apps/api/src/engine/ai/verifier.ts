/**
 * Deterministic verification of an AI ranking. The AI's choice is executed only when every check passes:
 *
 *   1. response_schema       the answer has the agreed shape
 *   2. hard_rules            every ranked campaign is an evaluated candidate that passed all hard filters
 *   3. citations_exist       every cited evidence id is in the decision's evidence set (no invented data)
 *   4. citations_trusted     every cited item comes from a trusted feed and is fresh enough
 *   5. claims_match          every fact the AI states equals the recorded value
 *   6. score_reproducible    each score, and the inputs it was computed from, match a recomputation from
 *                            the logged inputs
 *
 * If any check fails, the AI's choice is rejected and the screen falls back to the rule-based ranking.
 */
import { type Evidence, EvidenceSourceSchema, checkFreshness } from '@arm/domain';

import { type CandidateEvaluation, recomputeFinal } from '../scoring.js';
import { type AiRanking, AiRankingSchema } from './types.js';

export type CheckName =
  | 'response_schema'
  | 'hard_rules'
  | 'citations_exist'
  | 'citations_trusted'
  | 'claims_match'
  | 'score_reproducible';

export interface VerificationCheck {
  name: CheckName;
  passed: boolean;
  detail: string;
}

export interface Verification {
  passed: boolean;
  checks: VerificationCheck[];
  /** The verified ranking (campaign ids, best first), when `passed`. */
  ranking: string[];
  /** The parsed answer, when it matched the schema. */
  parsed: AiRanking | null;
}

/** Tolerance for numeric comparisons (scores and shares are logged to 4 decimals). */
export const TOLERANCE = 0.001;
const TRUSTED = new Set(EvidenceSourceSchema.options);

const sameValue = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= TOLERANCE : a === b;

const list = (items: readonly string[], max = 3) =>
  items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;

export function verifyRanking(
  answer: unknown,
  candidates: readonly CandidateEvaluation[],
  evidence: readonly Evidence[],
  now: Date,
): Verification {
  const checks: VerificationCheck[] = [];
  const parsed = AiRankingSchema.safeParse(answer);
  if (!parsed.success) {
    checks.push({
      name: 'response_schema',
      passed: false,
      detail: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    });
    return { passed: false, checks, ranking: [], parsed: null };
  }
  checks.push({
    name: 'response_schema',
    passed: true,
    detail: `${parsed.data.ranking.length} ranked candidates`,
  });
  const ranking = parsed.data.ranking;

  // 2. hard rules
  const byId = new Map(candidates.map((c) => [c.campaignId, c]));
  const notEligible = ranking.filter((r) => !byId.get(r.campaignId)?.eligible).map((r) => r.campaignId);
  const duplicates = ranking.map((r) => r.campaignId).filter((id, i, all) => all.indexOf(id) !== i);
  checks.push({
    name: 'hard_rules',
    passed: notEligible.length === 0 && duplicates.length === 0,
    detail:
      notEligible.length > 0
        ? `not eligible here: ${list(notEligible)}`
        : duplicates.length > 0
          ? `ranked twice: ${list(duplicates)}`
          : 'every ranked campaign passed all hard filters',
  });

  // 3–4. citations
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const cited = [...new Set(ranking.flatMap((r) => [...r.citations, ...r.claims.map((c) => c.evidenceId)]))];
  const missing = cited.filter((id) => !evidenceById.has(id));
  checks.push({
    name: 'citations_exist',
    passed: missing.length === 0,
    detail:
      missing.length > 0
        ? `not in any trusted feed: ${list(missing)}`
        : `${cited.length} citations, all recorded`,
  });
  const untrusted: string[] = [];
  for (const id of cited) {
    const e = evidenceById.get(id);
    if (!e) continue;
    const fresh = checkFreshness(e, now);
    if (!TRUSTED.has(e.source)) untrusted.push(`${id} (untrusted source)`);
    else if (!fresh.fresh) untrusted.push(`${id} (${fresh.ageSec}s old, limit ${fresh.limitSec}s)`);
  }
  checks.push({
    name: 'citations_trusted',
    passed: untrusted.length === 0,
    detail:
      untrusted.length > 0
        ? `stale or untrusted: ${list(untrusted)}`
        : 'all cited data from trusted feeds and fresh',
  });

  // 5. claims
  const wrong: string[] = [];
  for (const claim of ranking.flatMap((r) => r.claims)) {
    const e = evidenceById.get(claim.evidenceId);
    if (e && !sameValue(claim.value, e.value))
      wrong.push(`${claim.evidenceId}: claimed ${String(claim.value)}, recorded ${String(e.value)}`);
  }
  checks.push({
    name: 'claims_match',
    passed: wrong.length === 0,
    detail: wrong.length > 0 ? list(wrong, 2) : 'every stated fact matches the recorded value',
  });

  // 6. scores
  const mismatched: string[] = [];
  for (const r of ranking) {
    const logged = byId.get(r.campaignId)?.score;
    if (!logged) continue;
    const inputsMatch =
      sameValue(r.inputs.match, logged.match) &&
      sameValue(r.inputs.boost, logged.boost) &&
      sameValue(r.inputs.performance, logged.performance);
    const recomputed = recomputeFinal({
      ...r.inputs,
      audienceWeight: logged.audienceWeight,
      performanceWeight: logged.performanceWeight,
    });
    if (!inputsMatch) mismatched.push(`${r.campaignId}: inputs differ from the logged inputs`);
    else if (!sameValue(r.score, recomputed))
      mismatched.push(`${r.campaignId}: score ${r.score}, recomputed ${recomputed}`);
  }
  checks.push({
    name: 'score_reproducible',
    passed: mismatched.length === 0,
    detail: mismatched.length > 0 ? list(mismatched, 2) : 'every score recomputes from the logged inputs',
  });

  const passed = checks.every((c) => c.passed);
  return { passed, checks, ranking: passed ? ranking.map((r) => r.campaignId) : [], parsed: parsed.data };
}
