/**
 * In-process event bus. Everything that changes in the simulated world is published here once; the SSE
 * endpoint forwards it to browsers, and engines (presence, decisions) subscribe to what they need.
 */
import type { Flight, FlightEvent, QueueMeasurement } from '@arm/domain';

import type { FeedHealth } from '../adapters/contracts.js';
import type { ClockState } from './sim-clock.js';

export interface ScreenRuntime {
  id: string;
  status: 'online' | 'degraded' | 'offline';
  /** Simulation time the current status started. */
  since: string;
  latencyMs: number | null;
  lastHeartbeat: string | null;
  /** Set when the status was forced through simulation controls. */
  forced: boolean;
}

export interface IncidentView {
  id: string;
  kind: 'screen_offline' | 'feed_lag' | 'failed_creative';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  subject: string;
  owner: string | null;
  status: 'open' | 'acknowledged' | 'resolved';
  raisedAt: string;
  resolvedAt: string | null;
  details: Record<string, unknown>;
}

/** Topic → payload. */
export interface BusTopics {
  clock: ClockState;
  /** A flight changed (after an AIDX update or injection). */
  flight: { flight: Flight; event: FlightEvent };
  /** The whole flight set was reloaded (start-up or a clock jump). */
  flights_reloaded: { at: string; count: number };
  queue: QueueMeasurement;
  screen: ScreenRuntime;
  incident: IncidentView;
  feeds: FeedHealth[];
  /** Simulation control actions (play, pause, speed, jump, inject, reset), for the activity feed. */
  sim: { action: string; detail: Record<string, unknown>; at: string };
  /** Screens whose ad changed in a slot. */
  decisions: {
    at: string;
    changes: {
      screenId: string;
      runId: string;
      campaignId: string | null;
      creativeId: string | null;
      score: number | null;
      mode: string;
      contextId: string;
    }[];
  };
  /** Plays, cost, scans and redemptions of a slot, with today's running totals. */
  delivery: {
    at: string;
    plays: number;
    viewers: number;
    cost: number;
    scans: number;
    redemptions: { campaignId: string; outletId: string | null; revenue: number; screenId: string }[];
    today: {
      plays: number;
      viewers: number;
      cost: number;
      scans: number;
      redemptions: number;
      revenue: number;
    };
  };
  /** Zone presence for a new 5-minute window. */
  presence: { windowStart: string; zones: { zoneId: string; pax: number }[] };
  /** Promo claims from passengers' phones (claim page opened, code claimed, code shared). */
  claims: {
    action: 'opened' | 'claimed' | 'shared';
    campaignId: string;
    screenId: string;
    outletId: string | null;
    code: string | null;
    revenue: number;
    at: string;
  };
  /** Master data changed (the UIs refresh their lists). */
  catalog: { entity: string; id: string; action: string; at: string };
  /** The learning model retrained. */
  model: {
    version: string;
    trainedAt: string;
    changes: { campaignId: string; before: number; after: number }[];
  };
}

export type Topic = keyof BusTopics;

export interface BusMessage<T extends Topic = Topic> {
  topic: T;
  payload: BusTopics[T];
  /** Monotonic sequence number (SSE event id). */
  seq: number;
  /** Wall-clock time of publication (for latency measurements). */
  publishedAt: number;
}

type Listener = (message: BusMessage) => void;

export class EventBus {
  private seq = 0;
  private readonly listeners = new Set<Listener>();
  private readonly lastByTopic = new Map<Topic, BusMessage>();

  publish<T extends Topic>(topic: T, payload: BusTopics[T]): void {
    this.seq += 1;
    const message: BusMessage<T> = { topic, payload, seq: this.seq, publishedAt: Date.now() };
    this.lastByTopic.set(topic, message as BusMessage);
    for (const listener of this.listeners) {
      try {
        listener(message as BusMessage);
      } catch {
        // A failing subscriber must not stop delivery to the others.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The most recent message of a topic (lets a new SSE client start with the current clock). */
  last<T extends Topic>(topic: T): BusMessage<T> | undefined {
    return this.lastByTopic.get(topic) as BusMessage<T> | undefined;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
