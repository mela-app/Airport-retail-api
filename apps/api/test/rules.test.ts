import { describe, expect, it } from 'vitest';

import { DEFAULT_RULE_ENGINE } from '../src/db/seed.js';
import { type RuleInput, type ScreenHistory, applyBusinessRules } from '../src/engine/rules.js';
import type { CandidateEvaluation } from '../src/engine/scoring.js';

const cand = (id: string, final: number, extra: Partial<CandidateEvaluation> = {}): CandidateEvaluation => ({
  campaignId: id,
  campaignName: id,
  advertiserId: `adv-${id}`,
  advertiserName: `Advertiser ${id}`,
  competitorGroup: null,
  airlinePriority: false,
  creativeId: `cr-${id}`,
  eligible: true,
  filters: [],
  score: {
    match: final,
    dimensions: [],
    boost: 1,
    triggers: [],
    performance: 0,
    audienceWeight: 0.8,
    performanceWeight: 0.2,
    final,
  },
  ...extra,
});

// The worked example's candidates at Gate 42, 14:10.
const perfume = cand('c01', 0.86, { competitorGroup: 'perfume' });
const toys = cand('c02', 0.52);
const lounge = cand('c03', 0.21);
const oud = cand('c11', 0.6, { competitorGroup: 'perfume' });
const NOW = Date.parse('2026-10-16T10:10:00Z');

const history = (over: Partial<ScreenHistory> = {}): ScreenHistory => ({
  lastCampaignId: null,
  lastCompetitorGroup: null,
  consecutivePlays: 0,
  playsLastHour: new Map(),
  lastPlayedAt: new Map(),
  ...over,
});

function input(over: Partial<RuleInput> = {}): RuleInput {
  return {
    ranked: [perfume, toys, lounge],
    settings: { ...DEFAULT_RULE_ENGINE, explorationPct: 0 },
    history: history(),
    pin: null,
    frequencyCaps: new Map([['c01', 12]]),
    pacing: new Map(),
    dayElapsed: 0.5,
    now: NOW,
    random: 0.99,
    random2: 0,
    ...over,
  };
}

const rules = (out: ReturnType<typeof applyBusinessRules>) => out.applied.map((a) => a.rule);

describe('business rules', () => {
  it('plays the best candidate; the lounge (0.21) is held for screens where it fits better', () => {
    const out = applyBusinessRules(input());
    expect(out.winner?.campaignId).toBe('c01');
    expect(out.applied).toEqual([expect.objectContaining({ rule: 'relevance_floor', campaignId: 'c03' })]);
    expect(out.order.map((c) => c.campaignId)).toEqual(['c01', 'c02']);
  });

  it('frequency cap: a campaign at its hourly cap is skipped', () => {
    const out = applyBusinessRules(
      input({
        history: history({
          lastCampaignId: 'c01',
          lastCompetitorGroup: 'perfume',
          consecutivePlays: 1,
          playsLastHour: new Map([['c01', 12]]),
          lastPlayedAt: new Map([['c01', NOW - 3_600_000]]),
        }),
      }),
    );
    expect(out.winner?.campaignId).toBe('c02');
    expect(rules(out)).toContain('frequency_cap');
  });

  it('frequency cap spaces plays evenly: cap 60 per hour allows one play a minute', () => {
    const h = history({
      lastCampaignId: 'c02',
      consecutivePlays: 1,
      playsLastHour: new Map([['c01', 1]]),
      lastPlayedAt: new Map([['c01', NOW - 30_000]]),
    });
    const caps = new Map([['c01', 60]]);
    const soon = applyBusinessRules(input({ history: h, frequencyCaps: caps }));
    expect(soon.winner?.campaignId).toBe('c02');
    expect(soon.applied.find((a) => a.rule === 'frequency_cap')?.detail).toContain('one play every 60 s');
    expect(
      applyBusinessRules(input({ history: h, frequencyCaps: caps, now: NOW + 31_000 })).winner?.campaignId,
    ).toBe('c01');
  });

  it('competitor separation: no two perfume campaigns back to back', () => {
    const out = applyBusinessRules(
      input({
        ranked: [oud, toys],
        history: history({ lastCampaignId: 'c01', lastCompetitorGroup: 'perfume', consecutivePlays: 1 }),
      }),
    );
    expect(out.winner?.campaignId).toBe('c02');
    expect(out.applied.at(0)).toMatchObject({ rule: 'competitor_separation', campaignId: 'c11' });
  });

  it('airline priority: own gate messaging in the boarding window goes first', () => {
    const upgrade = cand('c07', 0.43, { airlinePriority: true, advertiserName: 'Halcyon Airways' });
    const out = applyBusinessRules(input({ ranked: [perfume, upgrade, toys] }));
    expect(out.winner?.campaignId).toBe('c07');
    expect(rules(out)).toEqual(['airline_priority']);
  });

  it('budget pacing scores down a campaign spending ahead of its daily pace', () => {
    const out = applyBusinessRules(
      input({
        ranked: [cand('c01', 0.6), cand('c02', 0.55)],
        pacing: new Map([['c01', { dailyCap: 1000, spend: { today: 800, total: 800 } }]]),
        dayElapsed: 0.5,
      }),
    );
    expect(out.winner?.campaignId).toBe('c02'); // 0.6 × 0.85 = 0.51 < 0.55
    expect(rules(out)).toEqual(['budget_pacing']);
  });

  it('rotation: after two plays in a row the next candidate gets the slot', () => {
    const h = history({
      lastCampaignId: 'c01',
      lastCompetitorGroup: 'perfume',
      consecutivePlays: 2,
      playsLastHour: new Map([['c01', 2]]),
    });
    const out = applyBusinessRules(input({ history: h }));
    expect(out.winner?.campaignId).toBe('c02');
    expect(out.applied).toContainEqual(expect.objectContaining({ rule: 'rotation', campaignId: 'c01' }));
    // ...but it keeps playing when it is the only candidate.
    expect(applyBusinessRules(input({ ranked: [perfume], history: h })).winner?.campaignId).toBe('c01');
  });

  it('a manual pin wins, with its reason (pins override the relevance floor)', () => {
    const out = applyBusinessRules(
      input({
        pin: { id: 'pin-1', campaignId: 'c03', reason: 'sponsor launch', createdBy: 'Media Manager' },
      }),
    );
    expect(out.winner?.campaignId).toBe('c03');
    expect(out.applied.at(0)?.detail).toContain('sponsor launch');
  });

  it('exploration gives a share of slots to another relevant candidate', () => {
    const settings = { ...DEFAULT_RULE_ENGINE, explorationPct: 10 };
    const explored = applyBusinessRules(input({ settings, random: 0.05, random2: 0.6 }));
    expect(explored.winner?.campaignId).toBe('c02');
    expect(rules(explored)).toContain('exploration');
    expect(applyBusinessRules(input({ settings, random: 0.5 })).winner?.campaignId).toBe('c01');
  });

  it('no winner when every candidate is capped (the house ad plays)', () => {
    const plays = new Map([
      ['c01', 99],
      ['c02', 99],
      ['c03', 99],
    ]);
    expect(applyBusinessRules(input({ history: history({ playsLastHour: plays }) })).winner).toBeNull();
  });
});
