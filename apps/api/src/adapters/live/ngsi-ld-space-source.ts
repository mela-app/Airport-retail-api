/**
 * `SPACE_SOURCE=ngsi-ld`: ACRIS entities from an NGSI-LD context broker (e.g. FIWARE Orion-LD).
 *
 *   GET {NGSI_LD_URL}/ngsi-ld/v1/entities?type=<ACRIS type>&limit=1000
 *
 * Facilities are read once; queue measurements are polled. Entities go through the same ACRIS parser as the
 * mock feed.
 */
import type { QueueMeasurement } from '@arm/domain';

import type { FeedClock, FeedHealth, SpaceSource } from '../contracts.js';
import { FeedStats } from '../feed-support.js';
import { type AcrisFacility, parseFacility, parseQueueMeasurement } from '../parsers/acris.js';
import { type HttpEndpoint, httpGet } from './http.js';

export interface NgsiLdSpaceSourceOptions {
  endpoint: HttpEndpoint;
  pollIntervalMs: number;
  clock: FeedClock;
}

const FACILITY_TYPES = [
  'TerminalFacility',
  'ConcourseFacility',
  'ZoneAreaLocation',
  'CheckpointFacility',
  'PassengerQueue',
];

export class NgsiLdSpaceSource implements SpaceSource {
  readonly adapter = 'ngsi-ld';
  private readonly stats = new FeedStats('acris', this.adapter);

  constructor(private readonly opts: NgsiLdSpaceSourceOptions) {}

  private async entities(type: string): Promise<unknown[]> {
    try {
      const body = await httpGet(
        this.opts.endpoint,
        ['ngsi-ld', 'v1', 'entities'],
        new Map([
          ['type', type],
          ['limit', '1000'],
        ]),
      );
      const data: unknown = JSON.parse(body);
      if (!Array.isArray(data)) throw new Error('NGSI-LD broker did not return an entity array');
      return data;
    } catch (err) {
      this.stats.unavailable((err as Error).message);
      throw err;
    }
  }

  async facilities(): Promise<AcrisFacility[]> {
    const out: AcrisFacility[] = [];
    for (const type of FACILITY_TYPES) {
      for (const e of await this.entities(type)) {
        try {
          out.push(parseFacility(e));
        } catch (err) {
          this.stats.rejectedMessage((err as Error).message);
        }
      }
    }
    return out;
  }

  async latest(): Promise<QueueMeasurement[]> {
    const byQueue = new Map<string, QueueMeasurement>();
    for (const e of await this.entities('QueueMeasurement')) {
      try {
        const m = parseQueueMeasurement(e);
        const current = byQueue.get(m.queueId);
        if (!current || current.measuredAt < m.measuredAt) byQueue.set(m.queueId, m);
      } catch (err) {
        this.stats.rejectedMessage((err as Error).message);
      }
    }
    this.stats.received(this.opts.clock.now(), byQueue.size);
    return [...byQueue.values()];
  }

  async *stream(_from: Date, signal: AbortSignal): AsyncIterable<QueueMeasurement> {
    const seen = new Set<string>();
    while (!signal.aborted) {
      try {
        for (const m of await this.latest()) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          yield m;
        }
      } catch {
        // recorded in feed health; retry on the next poll
      }
      await this.opts.clock.sleepUntil(
        new Date(this.opts.clock.now().getTime() + this.opts.pollIntervalMs),
        signal,
      );
    }
  }

  health(): FeedHealth[] {
    return [this.stats.health()];
  }
}
