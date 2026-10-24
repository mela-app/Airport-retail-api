import { describe, expect, it } from 'vitest';

import { DEFAULT_RULE_ENGINE } from '../src/db/seed.js';
import { MockAiRanker, type MockFault } from '../src/engine/ai/mock-agent.js';
import { buildRankRequest } from '../src/engine/ai/request.js';
import { verifyRanking } from '../src/engine/ai/verifier.js';
import { buildEvidence } from '../src/engine/evidence.js';
import { screenCrowd } from '../src/engine/presence.js';
import { type CampaignBundle, evaluateCampaigns } from '../src/engine/scoring.js';
import { LiveState } from '../src/sim/live-state.js';
import { at, presenceInputs, world } from './support/world.js';

/** The worked example decision at Gate 42, 14:10, up to the AI step. */
function decision(evidenceTime = at(14, 10)) {
  const w = world();
  const inv = w.inventory;
  const now = at(14, 10);
  const inputs = presenceInputs(now);
  const state = new LiveState();
  state.replaceFlights(inputs.flights, inputs.profiles, evidenceTime);
  const screen = inv.screens.find((s) => s.id === 'SCR-T2-D-01');
  if (!screen) throw new Error('screen missing');
  const crowd = screenCrowd(screen, inputs, now, 14);
  const bundles: CampaignBundle[] = inv.campaigns.map((campaign) => ({
    campaign,
    advertiser: inv.advertisers.find((a) => a.id === campaign.advertiserId),
    creatives: inv.creatives.filter((c) => campaign.creativeIds.includes(c.id)),
  }));
  const settings = { ...DEFAULT_RULE_ENGINE };
  const candidates = evaluateCampaigns(bundles, {
    now,
    utcOffsetMinutes: 240,
    screen,
    crowd,
    settings,
    performance: new Map(),
    spend: new Map(),
    gateChanges: new Map(),
    festival: null,
  });
  const evidence = buildEvidence({
    now,
    screenId: screen.id,
    screenStatus: { status: 'online', lastHeartbeat: now.toISOString() },
    crowd,
    candidates,
    state,
    model: { version: 'seed', trainedAt: now.toISOString() },
  });
  const request = buildRankRequest({
    screenId: screen.id,
    at: now,
    crowd,
    candidates,
    evidence,
    settings,
    segmentWeights: new Map(inv.campaigns.map((c) => [c.id, c.segmentWeights])),
  });
  return { now, candidates, evidence, request };
}

describe('evidence-first AI decisions', () => {
  it('records every input with source, timestamp and reference', () => {
    const { evidence } = decision();
    const delay = evidence.find((e) => e.id === 'ev:aodb:XH501-D-20261016:delay_min');
    expect(delay).toMatchObject({ source: 'aodb', value: 45, subject: 'flight:XH501-D-20261016' });
    const holiday = evidence.find((e) => e.id === 'ev:derived:SCR-T2-D-01:share:tripPurpose.holiday');
    expect(holiday?.value).toBeCloseTo(0.58, 2);
    expect(holiday?.derivedFrom?.length).toBeGreaterThan(0);
    expect(evidence.some((e) => e.id === 'ev:redemption:c01:performance')).toBe(true);
  });

  it('a correct AI ranking passes all six checks and keeps the worked-example order', async () => {
    const { now, candidates, evidence, request } = decision();
    const result = await new MockAiRanker({ faultRate: 0 }).rank(request);
    const v = verifyRanking(result.answer, candidates, evidence, now);
    expect(v.checks.map((c) => [c.name, c.passed])).toEqual([
      ['response_schema', true],
      ['hard_rules', true],
      ['citations_exist', true],
      ['citations_trusted', true],
      ['claims_match', true],
      ['score_reproducible', true],
    ]);
    expect(v.ranking).toEqual(['c01', 'c02', 'c03']);
    const top = v.parsed?.ranking.at(0);
    expect(top?.score).toBe(0.86);
    expect(top?.rationale).toContain('71% audience match');
    expect(top?.citations).toContain('ev:aodb:XH501-D-20261016:delay_min');
  });

  const cases: [MockFault, string, RegExp][] = [
    ['forged_citation', 'citations_exist', /XX999/],
    ['wrong_claim', 'claims_match', /claimed/],
    ['inflated_score', 'score_reproducible', /recomputed/],
    ['ineligible_campaign', 'hard_rules', /c22/],
  ];
  it.each(cases)('rejects an AI answer with a %s', async (fault, check, detail) => {
    const { now, candidates, evidence, request } = decision();
    const result = await new MockAiRanker({ faultRate: 0, forceFault: fault }).rank(request);
    const v = verifyRanking(result.answer, candidates, evidence, now);
    expect(v.passed).toBe(false);
    expect(v.ranking).toEqual([]);
    const failed = v.checks.filter((c) => !c.passed);
    expect(failed.map((c) => c.name)).toContain(check);
    expect(failed.find((c) => c.name === check)?.detail).toMatch(detail);
  });

  it('rejects citations of stale data', async () => {
    // The flight data was last confirmed 7 hours before the decision (AODB limit: 6 h).
    const { now, candidates, evidence, request } = decision(at(7, 10));
    const result = await new MockAiRanker({ faultRate: 0 }).rank(request);
    const v = verifyRanking(result.answer, candidates, evidence, now);
    expect(v.passed).toBe(false);
    expect(v.checks.find((c) => c.name === 'citations_trusted')?.detail).toMatch(/limit 21600s/);
  });

  it('rejects answers that are not in the agreed shape', () => {
    const { now, candidates, evidence } = decision();
    for (const answer of [null, 'c01', { ranking: [] }, { ranking: [{ campaignId: 'c01', score: 2 }] }]) {
      const v = verifyRanking(answer, candidates, evidence, now);
      expect(v.passed).toBe(false);
      expect(v.checks.at(0)?.name).toBe('response_schema');
    }
  });

  it('the mock agent makes mistakes at the configured rate, reproducibly', async () => {
    const { request } = decision();
    let faulty = 0;
    const ranker = new MockAiRanker({ faultRate: 0.2 });
    for (let i = 0; i < 200; i += 1) {
      const r = await ranker.rank({
        ...request,
        at: new Date(Date.parse(request.at) + i * 15_000).toISOString(),
      });
      const again = await ranker.rank({
        ...request,
        at: new Date(Date.parse(request.at) + i * 15_000).toISOString(),
      });
      expect(again.answer).toEqual(r.answer);
      const top = (
        r.answer as { ranking: { campaignId: string; score: number; citations: string[] }[] }
      ).ranking.at(0);
      if (top?.campaignId !== 'c01' || top.score !== 0.86 || top.citations.some((c) => c.includes('XX999')))
        faulty += 1;
    }
    expect(faulty).toBeGreaterThan(15);
    expect(faulty).toBeLessThan(70);
  });
});
