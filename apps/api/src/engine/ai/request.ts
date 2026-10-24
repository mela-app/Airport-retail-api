/** Builds the request an AI ranker receives for one screen decision. */
import { type Evidence, SEGMENT_KEYS, segmentShare } from '@arm/domain';

import { crowdEvidenceId } from '../evidence.js';
import type { CrowdEstimate } from '../presence.js';
import type { CandidateEvaluation, RuleEngineSettings } from '../scoring.js';
import type { AiRankRequest } from './types.js';

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

export function buildRankRequest(input: {
  screenId: string;
  at: Date;
  crowd: CrowdEstimate;
  candidates: readonly CandidateEvaluation[];
  evidence: readonly Evidence[];
  settings: Pick<RuleEngineSettings, 'audienceWeight' | 'performanceWeight'>;
  segmentWeights: ReadonlyMap<string, Record<string, number>>;
}): AiRankRequest {
  const { crowd } = input;
  const topShares = SEGMENT_KEYS.map((segment) => ({
    segment,
    share: r4(segmentShare(crowd.profile, segment)),
    evidenceId: crowdEvidenceId(input.screenId, `share:${segment}`),
  }))
    .filter((s) => s.share > 0)
    .sort((a, b) => b.share - a.share);
  return {
    screenId: input.screenId,
    at: input.at.toISOString(),
    crowd: {
      pax: crowd.pax,
      medianDwellMin: crowd.medianDwellMin,
      maxDelayMin: crowd.maxDelayMin,
      topShares,
      flights: crowd.contributors.slice(0, 12).map((c) => ({
        flightId: c.flightId,
        label: `${c.airlineIata}${c.flightNumber} → ${c.destination}`,
        pax: Math.round(c.pax),
        delayMin: c.delayMin,
        dwellMin: c.dwellMin,
      })),
    },
    candidates: input.candidates
      .filter((c) => c.eligible && c.score)
      .map((c) => ({
        campaignId: c.campaignId,
        name: c.campaignName,
        advertiser: c.advertiserName,
        match: c.score?.match ?? 0,
        boost: c.score?.boost ?? 1,
        performance: c.score?.performance ?? 0,
        triggers: c.score?.triggers.map((t) => t.detail) ?? [],
        segmentWeights: input.segmentWeights.get(c.campaignId) ?? {},
      })),
    scoring: {
      audienceWeight: input.settings.audienceWeight,
      performanceWeight: input.settings.performanceWeight,
      formula: 'score = audienceWeight * min(1, match * boost) + performanceWeight * performance',
    },
    evidence: input.evidence.map((e) => ({ id: e.id, source: e.source, field: e.field, value: e.value })),
  };
}
