/**
 * `SPACE_SOURCE=mock-acris`: the simulated ACRIS feed. Facilities come from `acris/entities.jsonld`; queue
 * measurements from `acris/queue-measurements.ndjson` (NGSI-LD QueueMeasurement entities), released when the
 * simulation clock reaches each measurement's end time. Every entity goes through the ACRIS parser.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { QueueMeasurement } from '@arm/domain';

import type { FeedClock, FeedHealth, SpaceSource } from '../contracts.js';
import { FeedStats, type Timed, firstAfter, replay } from '../feed-support.js';
import { type AcrisFacility, parseFacility, parseQueueMeasurement } from '../parsers/acris.js';

export interface MockSpaceSourceOptions {
  dayDir: string;
  clock: FeedClock;
}

export class MockAcrisSpaceSource implements SpaceSource {
  readonly adapter = 'mock-acris';
  private readonly facilityList: AcrisFacility[] = [];
  private readonly measurements: Timed<QueueMeasurement>[] = [];
  private readonly stats = new FeedStats('acris', this.adapter);

  constructor(private readonly opts: MockSpaceSourceOptions) {
    const entities: unknown = JSON.parse(readFileSync(join(opts.dayDir, 'acris', 'entities.jsonld'), 'utf8'));
    for (const entity of Array.isArray(entities) ? entities : []) {
      try {
        this.facilityList.push(parseFacility(entity));
      } catch (err) {
        this.stats.rejectedMessage((err as Error).message);
      }
    }
    const lines = readFileSync(join(opts.dayDir, 'acris', 'queue-measurements.ndjson'), 'utf8').split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const m = parseQueueMeasurement(JSON.parse(line));
        this.measurements.push({ at: Date.parse(m.measuredAt), value: m });
      } catch (err) {
        this.stats.rejectedMessage((err as Error).message);
      }
    }
    this.measurements.sort((a, b) => a.at - b.at);
  }

  async facilities(): Promise<AcrisFacility[]> {
    return [...this.facilityList];
  }

  async latest(at: Date): Promise<QueueMeasurement[]> {
    const end = firstAfter(this.measurements, at.getTime());
    const byQueue = new Map<string, QueueMeasurement>();
    for (const { value } of this.measurements.slice(0, end)) byQueue.set(value.queueId, value);
    if (byQueue.size > 0) this.stats.received(this.opts.clock.now(), byQueue.size);
    return [...byQueue.values()];
  }

  async *stream(from: Date, signal: AbortSignal): AsyncIterable<QueueMeasurement> {
    for await (const m of replay(this.measurements, from, this.opts.clock, signal)) {
      this.stats.received(this.opts.clock.now());
      yield m;
    }
  }

  health(): FeedHealth[] {
    return [this.stats.health()];
  }
}
