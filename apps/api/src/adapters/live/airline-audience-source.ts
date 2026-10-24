/**
 * `AUDIENCE_SOURCE=airline-api`: aggregated audience profiles from airlines (booking mix, PNR statistics,
 * APIS aggregates). Profiles are aggregates per flight; the platform never requests or accepts data about
 * individual passengers.
 *
 *   POST {AIRLINE_API_URL}/audience-aggregates  {"flightIds": [...]}
 *     →  {"<flight id>": <CrowdProfile>, ...}   (the same format as the mock feed)
 */
import type { CrowdProfile, Flight } from '@arm/domain';

import type { AudienceSource, FeedClock, FeedHealth } from '../contracts.js';
import { FeedStats } from '../feed-support.js';
import { parseAudienceProfiles } from '../parsers/audience.js';
import { type HttpEndpoint, httpPostJson } from './http.js';

export interface AirlineAudienceSourceOptions {
  endpoint: HttpEndpoint;
  clock: FeedClock;
}

const BATCH = 200;

export class AirlineApiAudienceSource implements AudienceSource {
  readonly adapter = 'airline-api';
  private readonly stats = new FeedStats('audience', this.adapter);

  constructor(private readonly opts: AirlineAudienceSourceOptions) {}

  async profiles(flights: readonly Flight[]): Promise<Map<string, CrowdProfile>> {
    const out = new Map<string, CrowdProfile>();
    for (let i = 0; i < flights.length; i += BATCH) {
      const ids = flights.slice(i, i + BATCH).map((f) => f.id);
      try {
        const body = await httpPostJson(this.opts.endpoint, ['audience-aggregates'], { flightIds: ids });
        const { profiles, errors } = parseAudienceProfiles(body);
        for (const e of errors) this.stats.rejectedMessage(`${e.flightId}: ${e.reason}`);
        for (const id of ids) {
          const p = profiles.get(id);
          if (p) out.set(id, p);
        }
        this.stats.received(this.opts.clock.now(), profiles.size);
      } catch (err) {
        this.stats.unavailable((err as Error).message);
      }
    }
    return out;
  }

  health(): FeedHealth[] {
    return [this.stats.health()];
  }
}
