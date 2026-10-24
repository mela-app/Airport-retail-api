/**
 * `AUDIENCE_SOURCE=mock-rules`: aggregated crowd profiles per flight. Profiles come from the mock feed
 * (`audience/flight-profiles.json`); a flight the feed does not cover (e.g. one added later) gets a profile
 * from the same plausibility rules the generator uses (route type, day of week, time of day, season).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type CrowdProfile,
  type Flight,
  aircraftTypeByIcao,
  airlineByIata,
  destinationByIata,
  toLocal,
} from '@arm/domain';
import { Rng, calendarDay, flightProfile } from '@arm/mockgen';

import type { AudienceSource, FeedClock, FeedHealth } from '../contracts.js';
import { FeedStats } from '../feed-support.js';
import { parseAudienceProfiles } from '../parsers/audience.js';

export interface MockAudienceSourceOptions {
  dayDir: string;
  utcOffsetMinutes: number;
  clock: FeedClock;
}

export class MockRulesAudienceSource implements AudienceSource {
  readonly adapter = 'mock-rules';
  private readonly feed: Map<string, CrowdProfile>;
  private readonly stats = new FeedStats('audience', this.adapter);

  constructor(private readonly opts: MockAudienceSourceOptions) {
    const { profiles, errors } = parseAudienceProfiles(
      readFileSync(join(opts.dayDir, 'audience', 'flight-profiles.json'), 'utf8'),
    );
    this.feed = profiles;
    this.stats.received(opts.clock.now(), profiles.size);
    for (const e of errors) this.stats.rejectedMessage(`${e.flightId}: ${e.reason}`);
  }

  private fromRules(flight: Flight): CrowdProfile | undefined {
    const other = destinationByIata(flight.direction === 'D' ? flight.destination : flight.origin);
    const airline = airlineByIata(flight.airlineIata);
    const aircraft = aircraftTypeByIcao(flight.aircraftTypeIcao);
    if (!other || !airline || !aircraft) return undefined;
    const local = toLocal(flight.scheduledTime, this.opts.utcOffsetMinutes);
    const cal = calendarDay(local.date);
    return flightProfile(
      {
        destination: other,
        direction: flight.direction,
        airline,
        aircraft,
        pax: flight.pax ?? Math.round(flight.seats * 0.8),
        local,
        schoolHoliday: cal.schoolHoliday,
        festival: cal.festival !== null,
      },
      new Rng(`profile:${flight.id}`),
    );
  }

  async profiles(flights: readonly Flight[]): Promise<Map<string, CrowdProfile>> {
    const out = new Map<string, CrowdProfile>();
    for (const f of flights) {
      const profile = this.feed.get(f.id) ?? this.fromRules(f);
      // The feed profile is for the booked load; keep its shares but use the latest pax count.
      if (profile) out.set(f.id, f.pax === null ? profile : { ...profile, pax: f.pax });
    }
    return out;
  }

  health(): FeedHealth[] {
    return [this.stats.health()];
  }
}
