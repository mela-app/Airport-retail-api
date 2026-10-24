/**
 * `AI_PROVIDER=mock`: an offline stand-in for an LLM ranking agent, so the demo works with no API key.
 *
 * It answers in exactly the shape an LLM is asked for: a ranking with inputs, a short rationale, the evidence
 * ids it relied on and the facts it claims. Like a real model it is sometimes wrong: with probability
 * `faultRate` (seeded, so reproducible) it forges a citation, misstates a fact, inflates a score or ranks a
 * campaign that is not eligible. The verifier must catch every one of these; the decision log shows it did.
 */
import { Rng } from '@arm/mockgen';

import type { AiRankRequest, AiRankResult, AiRanker, AiRankedCandidate, AiRanking } from './types.js';

export type MockFault = 'forged_citation' | 'wrong_claim' | 'inflated_score' | 'ineligible_campaign';
const FAULTS: readonly MockFault[] = [
  'forged_citation',
  'wrong_claim',
  'inflated_score',
  'ineligible_campaign',
];

const round = (v: number) => Math.round(v * 10_000) / 10_000;
const pct = (v: number) => `${Math.round(v * 100)}%`;

export interface MockAgentOptions {
  /** Share of answers with a deliberate error (0–1). */
  faultRate: number;
  /** Force one fault on every answer (tests). */
  forceFault?: MockFault;
}

export class MockAiRanker implements AiRanker {
  readonly provider = 'mock';
  readonly model = 'mock-ranker-v1';

  constructor(private readonly opts: MockAgentOptions) {}

  private candidate(request: AiRankRequest, c: AiRankRequest['candidates'][number]): AiRankedCandidate {
    const { audienceWeight, performanceWeight } = request.scoring;
    const score = round(audienceWeight * Math.min(1, c.match * c.boost) + performanceWeight * c.performance);
    // Cite the crowd shares behind the campaign's biggest weights, the delay that boosts it, and its performance.
    const weighted = request.crowd.topShares
      .filter((s) => (new Map(Object.entries(c.segmentWeights)).get(s.segment) ?? 0) > 0)
      .slice(0, 3);
    const citations = weighted.map((s) => s.evidenceId);
    const claims = weighted.map((s) => ({ evidenceId: s.evidenceId, value: s.share }));
    const delayed = request.crowd.flights
      .filter((f) => f.delayMin > 0)
      .sort((a, b) => b.delayMin - a.delayMin)
      .at(0);
    const delayEvidence = delayed
      ? request.evidence.find((e) => e.id.endsWith(`${delayed.flightId}:delay_min`))
      : undefined;
    if (c.boost > 1 && delayed && delayEvidence) {
      citations.push(delayEvidence.id);
      claims.push({ evidenceId: delayEvidence.id, value: delayed.delayMin });
    }
    const perfId = `ev:redemption:${c.campaignId}:performance`;
    citations.push(perfId);
    claims.push({ evidenceId: perfId, value: c.performance });
    const drivers = weighted.map((s) => `${s.segment.split('.').at(1)} ${pct(s.share)}`).join(', ');
    const rationale =
      `${pct(c.match)} audience match${drivers ? ` (${drivers})` : ''}` +
      (c.boost > 1 ? `, boosted ×${c.boost}${c.triggers.length ? ` by ${c.triggers.join('; ')}` : ''}` : '') +
      `, performance ${c.performance.toFixed(2)}.`;
    return {
      campaignId: c.campaignId,
      score,
      inputs: { match: c.match, boost: c.boost, performance: c.performance },
      rationale,
      citations,
      claims,
    };
  }

  private inject(ranking: AiRanking, fault: MockFault): AiRanking {
    const [top, ...rest] = ranking.ranking;
    if (!top) return ranking;
    switch (fault) {
      case 'forged_citation':
        return {
          ranking: [
            {
              ...top,
              citations: [...top.citations, 'ev:aidx:XX999-D-20261016:delay_min'],
              rationale: `${top.rationale} Flight XX999 is also delayed.`,
            },
            ...rest,
          ],
        };
      case 'wrong_claim': {
        const claim = top.claims.at(0);
        if (!claim || typeof claim.value !== 'number') return ranking;
        return {
          ranking: [
            {
              ...top,
              claims: [{ ...claim, value: round(Math.min(1, claim.value + 0.25)) }, ...top.claims.slice(1)],
            },
            ...rest,
          ],
        };
      }
      case 'inflated_score':
        return { ranking: [{ ...top, score: round(Math.min(1, top.score + 0.15)) }, ...rest] };
      case 'ineligible_campaign':
        return {
          ranking: [
            { ...top, campaignId: 'c22', rationale: 'Destination campaign fits the international crowd.' },
            ...rest,
          ],
        };
    }
  }

  async rank(request: AiRankRequest): Promise<AiRankResult> {
    const started = Date.now();
    const ranking: AiRanking = {
      ranking: request.candidates
        .map((c) => this.candidate(request, c))
        .sort((a, b) => b.score - a.score || a.campaignId.localeCompare(b.campaignId)),
    };
    const rng = new Rng(`ai:${request.screenId}:${request.at}`);
    const fault = this.opts.forceFault ?? (rng.chance(this.opts.faultRate) ? rng.pick(FAULTS) : undefined);
    const answer = fault ? this.inject(ranking, fault) : ranking;
    return {
      provider: this.provider,
      model: this.model,
      latencyMs: Date.now() - started,
      answer,
      error: null,
    };
  }
}
