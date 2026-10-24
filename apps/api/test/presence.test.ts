import { ZONES, segmentShare } from '@arm/domain';
import { describe, expect, it } from 'vitest';

import { allZonePresence, gateAreaWeight, proximityWeight, screenCrowd } from '../src/engine/presence.js';
import { at, presenceInputs, world } from './support/world.js';

const GATE_42_SCREEN = 'SCR-T2-D-01';

describe('presence model', () => {
  it('gate-area weight: arriving over the last 2 hours, full in the last hour, leaving during boarding', () => {
    const inputs = presenceInputs(at(12, 0));
    const xh501 = inputs.flights.find((f) => f.id === 'XH501-D-20261016');
    if (!xh501) throw new Error('XH501 missing');
    // STD 14:57 local; the 45-min delay is known from 13:57 → ETD 15:42, boarding 15:02, gate close 15:32.
    const delayed = { ...xh501, estimatedTime: '2026-10-16T11:42:00Z' };
    expect(gateAreaWeight(delayed, at(13, 2))).toBe(0); // 120 min before boarding
    expect(gateAreaWeight(delayed, at(13, 32))).toBeCloseTo(0.5, 5);
    expect(gateAreaWeight(delayed, at(14, 10))).toBe(1);
    expect(gateAreaWeight(delayed, at(15, 17))).toBeCloseTo(0.5, 5); // half-way through boarding
    expect(gateAreaWeight(delayed, at(15, 32))).toBe(0);
    expect(proximityWeight(60)).toBe(1);
    expect(proximityWeight(110)).toBeCloseTo(0.5, 5);
    expect(proximityWeight(150)).toBe(0);
  });

  it('reproduces the worked example crowd at Gate 42, 14:10', () => {
    const inputs = presenceInputs(at(14, 10));
    const screen = world().inventory.screens.find((s) => s.id === GATE_42_SCREEN);
    if (!screen) throw new Error('screen missing');
    const crowd = screenCrowd(screen, inputs, at(14, 10), 14);

    expect(crowd.contributors.map((c) => c.flightId).sort()).toEqual(['XH501-D-20261016', 'XU88-D-20261016']);
    expect(crowd.pax).toBe(420);
    const pct = (k: Parameters<typeof segmentShare>[1]) => Math.round(segmentShare(crowd.profile, k) * 100);
    expect(pct('tripPurpose.holiday')).toBe(58);
    expect(pct('partyType.family')).toBe(31);
    expect(pct('tripPurpose.business')).toBe(22);
    expect(pct('market.international')).toBe(57);
    expect(crowd.medianDwellMin).toBe(52);
    expect(crowd.maxDelayMin).toBe(45);
    expect(crowd.regionShares).toMatchObject({ gulf: 0.5714 });
  });

  it('zone presence is plausible over the day and follows the flights', () => {
    for (const hour of [8, 14, 19]) {
      const zones = allZonePresence(presenceInputs(at(hour, 0)), at(hour, 0));
      const airside = ZONES.filter((z) => z.side === 'airside').reduce(
        (s, z) => s + (zones.get(z.id)?.pax ?? 0),
        0,
      );
      // A 900-flight day: thousands of passengers airside at any busy hour.
      expect(airside).toBeGreaterThan(1500);
      expect(airside).toBeLessThan(15000);
      for (const z of zones.values()) {
        const total = Object.values(z.profile.segments.tripPurpose).reduce((a, b) => a + b, 0);
        if (z.pax > 0 && z.contributors.length > 0) expect(total).toBeCloseTo(1, 2);
      }
    }
  });

  it('security and passport zones use the measured ACRIS queue occupancy', () => {
    const t = at(19, 0);
    const inputs = presenceInputs(t);
    const zones = allZonePresence(inputs, t);
    const sec = zones.get('T2-SEC');
    const queued = [...inputs.queues.values()]
      .filter((q) => q.checkpointId === 'T2-SEC-CP')
      .reduce((s, q) => s + q.occupancy, 0);
    expect(sec?.pax).toBe(queued);
    expect(sec?.queues.length).toBe(2);
  });
});
