import { describe, expect, it } from 'vitest';

import { DEFAULT_RULE_ENGINE } from '../src/db/seed.js';
import { screenCrowd } from '../src/engine/presence.js';
import {
  type CampaignBundle,
  type ScoringContext,
  audienceMatch,
  evaluateCampaigns,
  recomputeFinal,
} from '../src/engine/scoring.js';
import { at, presenceInputs, world } from './support/world.js';

function bundles(): CampaignBundle[] {
  const inv = world().inventory;
  return inv.campaigns.map((campaign) => ({
    campaign,
    advertiser: inv.advertisers.find((a) => a.id === campaign.advertiserId),
    creatives: inv.creatives.filter((c) => campaign.creativeIds.includes(c.id)),
  }));
}

function context(hour: number, minute: number, screenId = 'SCR-T2-D-01'): ScoringContext {
  const inv = world().inventory;
  const screen = inv.screens.find((s) => s.id === screenId);
  if (!screen) throw new Error(`screen ${screenId} missing`);
  const t = at(hour, minute);
  const inZone = inv.screens.filter((s) => s.zoneId === screen.zoneId).length;
  return {
    now: t,
    utcOffsetMinutes: 240,
    screen,
    crowd: screenCrowd(screen, presenceInputs(t), t, inZone),
    settings: { ...DEFAULT_RULE_ENGINE },
    performance: new Map(),
    spend: new Map(),
    gateChanges: new Map(),
    festival: null,
  };
}

describe('scoring', () => {
  it('reproduces the worked example at Gate 42, 14:10', () => {
    const ranked = evaluateCampaigns(bundles(), context(14, 10)).filter((c) => c.eligible);
    const top = ranked.slice(0, 3).map((c) => ({
      id: c.campaignId,
      match: Math.round((c.score?.match ?? 0) * 100),
      boost: c.score?.boost,
      final: Number((c.score?.final ?? 0).toFixed(2)),
    }));
    expect(top).toEqual([
      { id: 'c01', match: 71, boost: 1.5, final: 0.86 }, // duty-free perfume, 15% off: plays
      { id: 'c02', match: 49, boost: 1, final: 0.52 }, // toy store, buy 2 get 1: next in rotation
      { id: 'c03', match: 18, boost: 1, final: 0.21 }, // business lounge day pass
    ]);
    expect(ranked).toHaveLength(3);
    expect(ranked.at(0)?.score?.triggers.at(0)?.detail).toContain('XH501 delayed 45 min');
  });

  it('explains why the other campaigns are not candidates there', () => {
    const all = evaluateCampaigns(bundles(), context(14, 10));
    const reason = (id: string) => all.find((c) => c.campaignId === id)?.filters.find((f) => !f.passed)?.rule;
    expect(reason('c05')).toBe('market'); // delayed coffee targets domestic crowds
    expect(reason('c07')).toBe('airline_window'); // XH501 boards in 52 min: not yet its window
    expect(reason('c08')).toBe('trigger_required'); // goodwill voucher needs a delay over 60 min
    expect(reason('c10')).toBe('placement'); // awareness perfume is booked in the plaza
    expect(reason('c22')).toBe('status'); // pending review
  });

  it('a growing delay activates the airline goodwill voucher, which then outranks perfume', () => {
    const ctx = context(14, 10);
    const crowd = {
      ...ctx.crowd,
      contributors: ctx.crowd.contributors.map((c) =>
        c.flightNumber === '501' ? { ...c, delayMin: 65 } : c,
      ),
    };
    const ranked = evaluateCampaigns(bundles(), { ...ctx, crowd }).filter((c) => c.eligible);
    expect(ranked.at(0)?.campaignId).toBe('c08');
    expect(ranked.at(0)?.score?.triggers.at(0)?.type).toBe('delay_over');
  });

  it('scores are reproducible from the logged inputs', () => {
    for (const c of evaluateCampaigns(bundles(), context(14, 10))) {
      if (c.score) expect(recomputeFinal(c.score)).toBe(c.score.final);
    }
  });

  it('audience match is the mean over targeted dimensions of share × weight', () => {
    const profile = context(14, 10).crowd.profile;
    const { match, dimensions } = audienceMatch(
      { 'partyType.family': 1, 'market.international': 1 },
      profile,
    );
    expect(dimensions.map((d) => d.dimension)).toEqual(['partyType', 'market']);
    expect(match).toBeCloseTo((0.31 + 0.5714) / 2, 2);
    expect(audienceMatch({}, profile).match).toBe(0);
  });
});
